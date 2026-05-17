import { db, logAudit, safeLog } from "../_shared/supabase.ts";
import { sendMessage, TelegramApiError } from "../_shared/telegram.ts";
import { sendReminderEmail } from "../_shared/email.ts";
import { computeNextTrigger } from "../_shared/rrule.ts";
import { isResourceBusy } from "../_shared/handlers/calendar.ts";
import { formatInTimeZone } from "date-fns-tz";
import type {
  ConditionPredicate,
  EventRow,
  JobOutboxRow,
  ListItemRow,
  MemoryBubbleRow,
  ReminderRow,
  ReminderStatus,
  StopCondition,
  TaskRow,
  TemplateId,
  ThenAction,
  ThenActionBranched,
  ThenActionSingle,
} from "../_shared/types.ts";

const OWNER_CHAT_ID = Number(Deno.env.get("OWNER_CHAT_ID"));
if (!OWNER_CHAT_ID || Number.isNaN(OWNER_CHAT_ID)) {
  throw new Error("Missing or invalid OWNER_CHAT_ID env var");
}

const CLAIM_BATCH = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBranchedThenAction(
  action: ThenAction,
): action is ThenActionBranched {
  return (
    isRecord(action) &&
    "branch_true" in action &&
    "branch_false" in action
  );
}

async function ownerTz(): Promise<string> {
  const { data } = await db.from("owner").select("timezone").eq("id", 1)
    .maybeSingle();
  return (data as { timezone?: string } | null)?.timezone || "UTC";
}

let cachedOwnerTz: string | null = null;

function tzOf(reminder: ReminderRow): string {
  return reminder.timezone || cachedOwnerTz || "UTC";
}

Deno.serve(async (req: Request): Promise<Response> => {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    safeLog("warn", "dispatch_unauthorized", {});

    return new Response("ok");
  }

  try {
    cachedOwnerTz = await ownerTz();
    const { data, error } = await db.rpc("claim_due_jobs", {
      batch: CLAIM_BATCH,
    });
    if (error) {
      safeLog("error", "claim_due_jobs_failed", { error: error.message });
      return new Response("ok");
    }

    const jobs = (data ?? []) as JobOutboxRow[];
    safeLog("info", "dispatch_tick", { claimed: jobs.length });

    for (const job of jobs) {
      await processSingleJob(job);
    }

    await processNudges();
  } catch (err: unknown) {
    safeLog("error", "dispatch_uncaught", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return new Response("ok");
});

async function processSingleJob(job: JobOutboxRow): Promise<void> {
  let reminder: ReminderRow | null = null;
  try {
    reminder = await loadReminder(job.reminder_id);
    if (!reminder) {
      safeLog("warn", "dispatch_reminder_missing", {
        job_id: job.id,
        reminder_id: job.reminder_id,
      });
      await markDelivered(job.id);
      return;
    }

    const result = await processJob(job, reminder);

    await markDelivered(job.id);
    await scheduleNextOccurrence(reminder, job, result);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    safeLog("error", "dispatch_job_failed", {
      job_id: job.id,
      reminder_id: job.reminder_id,
      error: errorMessage,
    });

    const updated = await markFailed(job.id, errorMessage);
    if (updated && updated.status === "dead_letter") {
      await notifyOwnerOfDeadLetter(reminder, updated);
    }
  }
}

async function loadReminder(reminderId: string): Promise<ReminderRow | null> {
  const { data, error } = await db
    .from("reminder")
    .select("*")
    .eq("id", reminderId)
    .maybeSingle();
  if (error) {
    throw new Error(`loadReminder failed: ${error.message}`);
  }
  return (data as ReminderRow | null) ?? null;
}

interface ProcessResult {
  delivered: boolean;

  stopMet?: boolean;
}

async function processJob(
  job: JobOutboxRow,
  reminder: ReminderRow,
): Promise<ProcessResult> {
  switch (reminder.kind) {
    case "static":
    case "recurring": {
      const content = reminder.content?.trim();
      if (!content) {
        throw new Error(
          `reminder ${reminder.id} (${reminder.kind}) has empty content`,
        );
      }
      const isCritical = hasCriticalKeywords(content);
      const message = await buildDeliveryMessage(
        content,
        tzOf(reminder),
        isCritical,
      );

      await sendMessage(OWNER_CHAT_ID, message);

      await createPendingAck(reminder.id, isCritical);

      sendReminderEmail(
        content,
        reminder.next_trigger_at ?? undefined,
        isCritical,
        tzOf(reminder),
      ).catch(() => {});

      return { delivered: true };
    }

    case "dynamic": {
      const content = await resolveTemplate(
        reminder.template_id,
        reminder.template_params,
        tzOf(reminder),
      );

      if (content.trim().length > 0) {
        await sendMessage(OWNER_CHAT_ID, content);
      }
      return { delivered: content.trim().length > 0 };
    }

    case "conditional": {
      return await runConditional(reminder, job);
    }

    case "escalation": {
      const content = reminder.content?.trim();
      if (!content) {
        throw new Error(
          `reminder ${reminder.id} (escalation) has empty content`,
        );
      }
      await sendMessage(OWNER_CHAT_ID, content);

      const stopMet = reminder.stop_condition
        ? await evaluateStopCondition(
          reminder.stop_condition,
          reminder.attempt_count + 1,
        )
        : false;
      return { delivered: true, stopMet };
    }

    case "composite": {
      safeLog("warn", "dispatch_composite_unexpected", {
        reminder_id: reminder.id,
        job_id: job.id,
      });
      return { delivered: true };
    }

    default: {
      const exhaustive: never = reminder.kind;
      throw new Error(`unsupported reminder kind: ${String(exhaustive)}`);
    }
  }
}

async function runConditional(
  reminder: ReminderRow,
  job: JobOutboxRow,
): Promise<ProcessResult> {
  if (!reminder.condition) {
    throw new Error(`conditional reminder ${reminder.id} has null condition`);
  }
  if (!reminder.then_action) {
    throw new Error(`conditional reminder ${reminder.id} has null then_action`);
  }

  const truthy = await evaluateCondition(reminder.condition, tzOf(reminder));

  if (isBranchedThenAction(reminder.then_action)) {
    const branch = truthy
      ? reminder.then_action.branch_true
      : reminder.then_action.branch_false;
    await executeSingleAction(branch, reminder);
    return { delivered: true };
  }

  if (truthy) {
    await executeSingleAction(reminder.then_action, reminder);
    return { delivered: true };
  }

  await logAudit("condition_skipped", {
    job_id: job.id,
    reminder_id: reminder.id,
    predicate_type: reminder.condition.predicate_type,
  });
  return { delivered: false };
}

async function executeSingleAction(
  action: ThenActionSingle,
  reminder: ReminderRow,
): Promise<void> {
  switch (action.type) {
    case "send_message": {
      const content = action.content?.trim();
      if (!content) {
        throw new Error(
          `then_action send_message for reminder ${reminder.id} has empty content`,
        );
      }
      await sendMessage(OWNER_CHAT_ID, content);
      return;
    }

    case "create_reminder": {
      if (!action.kind) {
        throw new Error(
          `then_action create_reminder for reminder ${reminder.id} requires kind`,
        );
      }
      const initialStatus: ReminderStatus =
        action.kind === "recurring" || action.kind === "escalation"
          ? "active"
          : "scheduled";
      const insertPayload: Record<string, unknown> = {
        kind: action.kind,
        status: initialStatus,
        content: action.content ?? null,
        next_trigger_at: action.next_trigger_at ?? null,
        recurrence_rule: action.recurrence_rule ?? null,
        escalation_rule: action.escalation_rule ?? null,
        stop_condition: action.stop_condition ?? null,
        linked_task_id: action.linked_task_id ?? null,
        linked_list_item_id: action.linked_list_item_id ?? null,
        template_id: action.template_id ?? null,
        template_params: action.template_params ?? null,
        timezone: tzOf(reminder),
        parent_reminder_id: reminder.id,
      };
      const { data, error } = await db
        .from("reminder")
        .insert(insertPayload)
        .select("id")
        .single();
      if (error || !data) {
        throw new Error(
          `executeSingleAction insert failed: ${
            error?.message ?? "no row returned"
          }`,
        );
      }
      const newId = (data as { id: string }).id;
      safeLog("info", "then_action_create_reminder", {
        parent_reminder_id: reminder.id,
        new_reminder_id: newId,
        kind: action.kind,
      });
      return;
    }

    default: {
      const exhaustive: never = action.type;
      throw new Error(`unsupported then_action type: ${String(exhaustive)}`);
    }
  }
}

export async function evaluateCondition(
  condition: ConditionPredicate,
  _tz: string,
): Promise<boolean> {
  const params = condition.params ?? {};

  switch (condition.predicate_type) {
    case "task_not_completed": {
      const taskId = stringParam(params, "task_id");
      const status = await fetchTaskStatus(taskId);
      return status !== "completed";
    }

    case "list_item_not_completed": {
      const itemId = stringParam(params, "list_item_id");
      const status = await fetchListItemStatus(itemId);
      return status !== "completed";
    }

    case "calendar_resource_busy": {
      const start = parseIsoParam(params, "window_start");
      const end = parseIsoParam(params, "window_end");
      return await isResourceBusy(start, end);
    }

    case "calendar_resource_free": {
      const start = parseIsoParam(params, "window_start");
      const end = parseIsoParam(params, "window_end");
      return !(await isResourceBusy(start, end));
    }

    case "time_window_reached_without_completion": {
      const deadline = parseIsoParam(params, "deadline");
      if (Date.now() < deadline.getTime()) return false;
      const taskId = stringParam(params, "task_id");
      const status = await fetchTaskStatus(taskId);
      return status !== "completed";
    }

    default: {
      const exhaustive: never = condition.predicate_type;
      throw new Error(
        `unsupported predicate_type: ${String(exhaustive)}`,
      );
    }
  }
}

async function evaluateStopCondition(
  stop: StopCondition,
  attemptCount: number,
): Promise<boolean> {
  const params = stop.params ?? {};
  switch (stop.type) {
    case "task_completed": {
      const taskId = stringParam(params, "task_id");
      const status = await fetchTaskStatus(taskId);
      return status === "completed";
    }
    case "list_item_completed": {
      const itemId = stringParam(params, "list_item_id");
      const status = await fetchListItemStatus(itemId);
      return status === "completed";
    }
    case "max_attempts_reached": {
      const max = numberParam(params, "max_attempts");
      return attemptCount >= max;
    }
    case "until_datetime_reached": {
      const until = parseIsoParam(params, "until");
      return Date.now() >= until.getTime();
    }
    case "user_acknowledged": {
      return false;
    }
    default: {
      const exhaustive: never = stop.type;
      throw new Error(
        `unsupported stop_condition type: ${String(exhaustive)}`,
      );
    }
  }
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
): string {
  const v = params[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`condition.params.${key} must be a non-empty string`);
  }
  return v;
}

function numberParam(
  params: Record<string, unknown>,
  key: string,
): number {
  const v = params[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`condition.params.${key} must be a finite number`);
  }
  return v;
}

function parseIsoParam(
  params: Record<string, unknown>,
  key: string,
): Date {
  const v = stringParam(params, key);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`condition.params.${key} must be ISO 8601: ${v}`);
  }
  return d;
}

async function fetchTaskStatus(taskId: string): Promise<string | null> {
  const { data, error } = await db
    .from("task")
    .select("status")
    .eq("id", taskId)
    .maybeSingle();
  if (error) {
    throw new Error(`fetchTaskStatus failed: ${error.message}`);
  }
  return (data as Pick<TaskRow, "status"> | null)?.status ?? null;
}

async function fetchListItemStatus(itemId: string): Promise<string | null> {
  const { data, error } = await db
    .from("list_item")
    .select("status")
    .eq("id", itemId)
    .maybeSingle();
  if (error) {
    throw new Error(`fetchListItemStatus failed: ${error.message}`);
  }
  return (data as Pick<ListItemRow, "status"> | null)?.status ?? null;
}

async function resolveTemplate(
  templateId: TemplateId | null,
  _params: Record<string, unknown> | null,
  tz: string,
): Promise<string> {
  if (!templateId) {
    throw new Error("dynamic reminder is missing template_id");
  }

  switch (templateId) {
    case "daily_briefing": {
      const isNightly =
        (_params as Record<string, unknown> | null)?.variant === "nightly";
      if (isNightly) {
        return await renderNightlySummary(tz);
      }
      return await renderDailyBriefing(tz, false);
    }
    case "tomorrow_agenda":
      return await renderDailyBriefing(tz, true);
    case "weekly_review":
      return await renderWeeklyReview(tz);
    case "pending_tasks":
      return await renderPendingTasks(tz);
    case "next_calendar_event":
      return await renderNextCalendarEvent(tz);
    case "stale_followup":
      return await renderStaleFollowup();
    default: {
      const exhaustive: never = templateId;
      throw new Error(`unsupported template_id: ${String(exhaustive)}`);
    }
  }
}

async function renderDailyBriefing(
  tz: string,
  tomorrow: boolean,
): Promise<string> {
  const dayOffset = tomorrow ? 1 : 0;
  const start = startOfDayInTz(new Date(), tz, dayOffset);
  const end = addDays(start, 1);

  const [reminders, events, tasks] = await Promise.all([
    fetchRemindersInWindow(start, end),
    fetchEventsInWindow(start, end),
    fetchTasksDueInWindow(start, end),
  ]);

  const greeting = tomorrow
    ? `${nightlyHello(tz)}\n\n🗓️ Mañana tienes:`
    : `${morningHello(tz)}\n\nHoy tienes:`;
  const empty = tomorrow
    ? `${nightlyHello(tz)}\n\nMañana tienes el día libre. Descansa.`
    : `${morningHello(tz)}\n\nHoy tienes el día libre.`;

  if (reminders.length === 0 && events.length === 0 && tasks.length === 0) {
    return empty;
  }

  const lines: string[] = [
    greeting,
    `• ${reminders.length} recordatorios`,
    `• ${events.length} eventos`,
    `• ${tasks.length} tareas pendientes`,
  ];

  if (events.length > 0) {
    lines.push("", "Eventos:");
    for (const e of events) {
      const time = formatInTimeZone(new Date(e.starts_at), tz, "HH:mm");
      lines.push(`• ${time} — ${e.title}`);
    }
  }
  if (reminders.length > 0) {
    lines.push("", "Recordatorios:");
    for (const r of reminders) {
      if (!r.next_trigger_at) continue;
      const time = formatInTimeZone(new Date(r.next_trigger_at), tz, "HH:mm");
      lines.push(`• ${time} — ${r.content ?? "(sin contenido)"}`);
    }
  }
  if (tasks.length > 0) {
    lines.push("", "Tareas:");
    for (const t of tasks) {
      lines.push(`• ${t.title}`);
    }
  }
  const bullets = lines.join("\n");

  const narrationGreeting = tomorrow ? nightlyHello(tz) : morningHello(tz);
  const tone: "morning" | "night" = tomorrow ? "night" : "morning";
  try {
    const mod = await import("../_shared/deepseek.ts");
    if (typeof mod.narrateBriefing === "function") {
      const narrated = await mod.narrateBriefing(
        bullets,
        narrationGreeting,
        tone,
      );
      if (narrated && narrated.length > 0) return narrated;
    }
  } catch (err) {
    safeLog("warn", "narrate_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return bullets;
}

async function renderWeeklyReview(tz: string): Promise<string> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const [
    { data: completedData, error: completedErr },
    { data: pendingData, error: pendingErr },
    { data: bubblesData, error: bubblesErr },
  ] = await Promise.all([
    db.from("task")
      .select("title, completed_at")
      .eq("status", "completed")
      .gte("completed_at", weekAgo.toISOString())
      .order("completed_at", { ascending: false })
      .limit(50),
    db.from("task")
      .select("title, due_at")
      .eq("status", "pending")
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(50),
    db.from("memory_bubble")
      .select("content, created_at")
      .is("deleted_at", null)
      .gte("created_at", weekAgo.toISOString())
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (completedErr) {
    throw new Error(
      `weekly_review completed query failed: ${completedErr.message}`,
    );
  }
  if (pendingErr) {
    throw new Error(
      `weekly_review pending query failed: ${pendingErr.message}`,
    );
  }
  if (bubblesErr) {
    throw new Error(
      `weekly_review bubbles query failed: ${bubblesErr.message}`,
    );
  }

  const completed = (completedData ?? []) as Array<
    Pick<TaskRow, "title" | "completed_at">
  >;
  const pending = (pendingData ?? []) as Array<
    Pick<TaskRow, "title" | "due_at">
  >;
  const bubbles = (bubblesData ?? []) as Array<
    Pick<MemoryBubbleRow, "content" | "created_at">
  >;

  if (completed.length === 0 && pending.length === 0 && bubbles.length === 0) {
    return "📊 Resumen semanal: sin actividad esta semana.";
  }

  const lines: string[] = [
    "📊 Resumen semanal",
    `• ${completed.length} tareas completadas`,
    `• ${pending.length} tareas pendientes`,
    `• ${bubbles.length} notas creadas`,
  ];
  if (completed.length > 0) {
    lines.push("", "Completadas:");
    for (const t of completed.slice(0, 10)) {
      const when = t.completed_at
        ? formatInTimeZone(new Date(t.completed_at), tz, "yyyy-MM-dd")
        : "";
      lines.push(`• ${t.title}${when ? ` (${when})` : ""}`);
    }
  }
  if (pending.length > 0) {
    lines.push("", "Pendientes:");
    for (const t of pending.slice(0, 10)) {
      lines.push(`• ${t.title}`);
    }
  }

  const { data: weekFeedback } = await db
    .from("feedback_event")
    .select("event_type, response_time_seconds")
    .gte("created_at", weekAgo.toISOString());

  const feedback = (weekFeedback ?? []) as Array<
    { event_type: string; response_time_seconds: number | null }
  >;
  const acked = feedback.filter((f) => f.event_type === "acknowledged");
  const snoozed = feedback.filter((f) => f.event_type === "snoozed");
  const ignored = feedback.filter((f) =>
    f.event_type === "ignored" || f.event_type === "nudged"
  );

  if (acked.length > 0 || snoozed.length > 0) {
    lines.push("", "📊 Estadísticas:");
    lines.push(`• Completados a tiempo: ${acked.length}`);
    if (snoozed.length > 0) lines.push(`• Pospuestos: ${snoozed.length}`);
    if (ignored.length > 0) {
      lines.push(`• Ignorados/insistidos: ${ignored.length}`);
    }

    const avgResponse = acked
      .filter((a) => a.response_time_seconds !== null)
      .map((a) => a.response_time_seconds as number);
    if (avgResponse.length > 0) {
      const avg = Math.round(
        avgResponse.reduce((a, b) => a + b, 0) / avgResponse.length / 60,
      );
      lines.push(`• Tiempo medio de respuesta: ${avg} min`);
    }
  }

  return lines.join("\n");
}

async function renderPendingTasks(tz: string): Promise<string> {
  const { data, error } = await db
    .from("task")
    .select("title, due_at, priority")
    .eq("status", "pending")
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) {
    throw new Error(`pending_tasks query failed: ${error.message}`);
  }
  const tasks = (data ?? []) as Array<
    Pick<TaskRow, "title" | "due_at" | "priority">
  >;
  if (tasks.length === 0) {
    return "📋 No tienes tareas pendientes.";
  }
  const lines: string[] = ["📋 Tareas pendientes:"];
  for (const t of tasks) {
    const when = t.due_at
      ? formatInTimeZone(new Date(t.due_at), tz, "yyyy-MM-dd HH:mm")
      : null;
    lines.push(`• ${t.title}${when ? ` — ${when}` : ""}`);
  }
  return lines.join("\n");
}

async function renderNextCalendarEvent(tz: string): Promise<string> {
  const { data, error } = await db
    .from("event")
    .select("title, starts_at, location")
    .gt("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`next_calendar_event query failed: ${error.message}`);
  }
  const event = data as
    | Pick<EventRow, "title" | "starts_at" | "location">
    | null;
  if (!event) {
    return "📅 No tienes eventos próximos.";
  }
  const when = formatInTimeZone(
    new Date(event.starts_at),
    tz,
    "yyyy-MM-dd HH:mm",
  );
  const loc = event.location ? ` · ${event.location}` : "";
  return `📅 Próximo evento: ${when} — ${event.title}${loc}`;
}

async function renderNightlySummary(tz: string): Promise<string> {
  const todayStart = startOfDayInTz(new Date(), tz, 0);
  const todayEnd = addDays(todayStart, 1);
  const tomorrowEnd = addDays(todayStart, 2);

  const { data: completedToday } = await db
    .from("feedback_event")
    .select("reminder_id")
    .eq("event_type", "acknowledged")
    .gte("created_at", todayStart.toISOString())
    .lt("created_at", todayEnd.toISOString());

  const [tomorrowReminders, tomorrowEvents, tomorrowTasks] = await Promise.all([
    fetchRemindersInWindow(todayEnd, tomorrowEnd),
    fetchEventsInWindow(todayEnd, tomorrowEnd),
    fetchTasksDueInWindow(todayEnd, tomorrowEnd),
  ]);

  const completedCount = (completedToday ?? []).length;
  const tomorrowTotal = tomorrowReminders.length + tomorrowEvents.length +
    tomorrowTasks.length;

  const lines: string[] = ["🌙 *Daily summary*", ""];

  if (completedCount > 0) {
    lines.push(
      `✅ Completaste ${completedCount} ${
        completedCount === 1 ? "cosa" : "cosas"
      } hoy. Buen trabajo.`,
    );
  } else {
    lines.push("Hoy fue un día tranquilo.");
  }

  lines.push("");

  if (tomorrowTotal > 0) {
    lines.push("📅 Mañana tienes:");
    for (const e of tomorrowEvents) {
      const time = formatInTimeZone(new Date(e.starts_at), tz, "HH:mm");
      lines.push(`• ${time} — ${e.title}`);
    }
    for (const r of tomorrowReminders) {
      if (!r.next_trigger_at) continue;
      const time = formatInTimeZone(new Date(r.next_trigger_at), tz, "HH:mm");
      lines.push(`• ${time} — ${r.content ?? "(recordatorio)"}`);
    }
    for (const t of tomorrowTasks) {
      lines.push(`• ${t.title}`);
    }
  } else {
    lines.push("Mañana no tienes nada agendado. Día libre 🎉");
  }

  lines.push("", "_Descansa bien. Yo me encargo de avisarte mañana._");
  return lines.join("\n");
}

async function renderStaleFollowup(): Promise<string> {
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const { data: staleAcks } = await db
    .from("pending_ack")
    .select("reminder_id")
    .is("acknowledged_at", null)
    .lte("delivered_at", threeDaysAgo)
    .limit(5);

  if (!staleAcks || staleAcks.length === 0) {
    return "";
  }

  const staleIds = (staleAcks as Array<{ reminder_id: string }>).map((a) =>
    a.reminder_id
  );
  const { data: staleData } = await db
    .from("reminder")
    .select("content")
    .in("id", staleIds);

  const staleContents = ((staleData ?? []) as Array<{ content: string | null }>)
    .map((r) => r.content?.trim())
    .filter((c): c is string => Boolean(c));

  if (staleContents.length === 0) {
    return "";
  }

  const lines: string[] = ["🔔 *Follow-up de pendientes*", ""];
  lines.push("Llevas unos días sin confirmar esto:");
  for (const content of staleContents) {
    lines.push(`• ${content}`);
  }
  lines.push("", '¿Ya lo hiciste? Dime "listo" o "cancelar" para cada uno.');
  return lines.join("\n");
}

async function fetchRemindersInWindow(
  start: Date,
  end: Date,
): Promise<Array<Pick<ReminderRow, "content" | "next_trigger_at">>> {
  const { data, error } = await db
    .from("reminder")
    .select("content, next_trigger_at")
    .in("status", ["scheduled", "active"])
    .gte("next_trigger_at", start.toISOString())
    .lt("next_trigger_at", end.toISOString())
    .order("next_trigger_at", { ascending: true });
  if (error) {
    throw new Error(`fetchRemindersInWindow failed: ${error.message}`);
  }
  return (data ?? []) as Array<
    Pick<ReminderRow, "content" | "next_trigger_at">
  >;
}

async function fetchEventsInWindow(
  start: Date,
  end: Date,
): Promise<Array<Pick<EventRow, "title" | "starts_at">>> {
  const { data, error } = await db
    .from("event")
    .select("title, starts_at")
    .gte("starts_at", start.toISOString())
    .lt("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });
  if (error) {
    throw new Error(`fetchEventsInWindow failed: ${error.message}`);
  }
  return (data ?? []) as Array<Pick<EventRow, "title" | "starts_at">>;
}

async function fetchTasksDueInWindow(
  start: Date,
  end: Date,
): Promise<Array<Pick<TaskRow, "title" | "due_at">>> {
  const { data, error } = await db
    .from("task")
    .select("title, due_at")
    .eq("status", "pending")
    .gte("due_at", start.toISOString())
    .lt("due_at", end.toISOString())
    .order("due_at", { ascending: true });
  if (error) {
    throw new Error(`fetchTasksDueInWindow failed: ${error.message}`);
  }
  return (data ?? []) as Array<Pick<TaskRow, "title" | "due_at">>;
}

async function scheduleNextOccurrence(
  reminder: ReminderRow,
  job: JobOutboxRow,
  result: ProcessResult,
): Promise<void> {
  const occurrenceAt = new Date(job.occurrence_at);

  switch (reminder.kind) {
    case "static": {
      await updateReminder(reminder.id, {
        status: "completed",
        next_trigger_at: null,
      });
      return;
    }

    case "recurring":
    case "dynamic": {
      const next = computeNextTrigger(reminder, occurrenceAt);
      if (!next) {
        await updateReminder(reminder.id, {
          status: "expired",
          next_trigger_at: null,
        });
        return;
      }
      await updateReminder(reminder.id, {
        status: "active",
        next_trigger_at: next.toISOString(),
      });
      return;
    }

    case "conditional": {
      if (reminder.stop_condition) {
        const stop = await evaluateStopCondition(
          reminder.stop_condition,
          reminder.attempt_count,
        );
        if (stop) {
          await updateReminder(reminder.id, {
            status: "completed",
            next_trigger_at: null,
          });
          return;
        }
      }

      if (!reminder.re_evaluation_rule) {
        await updateReminder(reminder.id, {
          status: "completed",
          next_trigger_at: null,
        });
        return;
      }

      const next = computeNextTrigger(reminder, occurrenceAt);
      if (!next) {
        await updateReminder(reminder.id, {
          status: "completed",
          next_trigger_at: null,
        });
        return;
      }
      await updateReminder(reminder.id, {
        status: "active",
        next_trigger_at: next.toISOString(),
      });
      return;
    }

    case "escalation": {
      const stopMet = result.stopMet ??
        (reminder.stop_condition
          ? await evaluateStopCondition(
            reminder.stop_condition,
            reminder.attempt_count + 1,
          )
          : false);
      if (stopMet) {
        await updateReminder(reminder.id, {
          status: "completed",
          next_trigger_at: null,
          attempt_count: reminder.attempt_count + 1,
        });
        return;
      }

      const newAttemptCount = reminder.attempt_count + 1;

      const next = computeNextTrigger(
        { ...reminder, attempt_count: newAttemptCount },
        occurrenceAt,
      );
      if (!next) {
        await updateReminder(reminder.id, {
          status: "completed",
          next_trigger_at: null,
          attempt_count: newAttemptCount,
        });
        return;
      }
      await updateReminder(reminder.id, {
        status: "active",
        next_trigger_at: next.toISOString(),
        attempt_count: newAttemptCount,
      });
      return;
    }

    case "composite": {
      return;
    }

    default: {
      const exhaustive: never = reminder.kind;
      throw new Error(
        `scheduleNextOccurrence: unsupported kind ${String(exhaustive)}`,
      );
    }
  }
}

async function updateReminder(
  id: string,
  patch: Partial<
    Pick<
      ReminderRow,
      "status" | "next_trigger_at" | "attempt_count"
    >
  >,
): Promise<void> {
  const { error } = await db
    .from("reminder")
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    throw new Error(`updateReminder failed: ${error.message}`);
  }
}

async function markDelivered(jobId: string): Promise<void> {
  const { error } = await db.rpc("mark_job_delivered", { p_job_id: jobId });
  if (error) {
    throw new Error(`mark_job_delivered failed: ${error.message}`);
  }
}

async function markFailed(
  jobId: string,
  errorMessage: string,
): Promise<JobOutboxRow | null> {
  const { data, error } = await db.rpc("mark_job_failed", {
    p_job_id: jobId,
    p_error: errorMessage,
  });
  if (error) {
    safeLog("error", "mark_job_failed_rpc_error", {
      job_id: jobId,
      error: error.message,
    });
    return null;
  }

  if (!data) return null;
  if (Array.isArray(data)) {
    return (data[0] as JobOutboxRow | undefined) ?? null;
  }
  return data as JobOutboxRow;
}

async function notifyOwnerOfDeadLetter(
  reminder: ReminderRow | null,
  job: JobOutboxRow,
): Promise<void> {
  const summary = reminder?.content?.trim() ||
    `recordatorio ${job.reminder_id}`;
  const lastError = job.last_error?.trim() || "(sin detalle)";
  const message =
    `⚠️ No pude entregar un recordatorio tras 5 intentos: «${summary}». Última causa: ${lastError}`;

  try {
    await sendMessage(OWNER_CHAT_ID, message);
    safeLog("warn", "dead_letter_notified", {
      job_id: job.id,
      reminder_id: job.reminder_id,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (err instanceof TelegramApiError) {
      safeLog("error", "dead_letter_notify_failed", {
        job_id: job.id,
        method: err.method,
        status_code: err.statusCode,
      });
    } else {
      safeLog("error", "dead_letter_notify_failed", {
        job_id: job.id,
        error: errorMessage,
      });
    }
  }
}

function startOfDayInTz(
  date: Date,
  tz: string,
  dayOffset = 0,
): Date {
  const shifted = new Date(date.getTime() + dayOffset * 86_400_000);
  const ymd = formatInTimeZone(shifted, tz, "yyyy-MM-dd");
  const offset = formatInTimeZone(shifted, tz, "xxx");
  const iso = `${ymd}T00:00:00${offset === "Z" ? "+00:00" : offset}`;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) {
    throw new Error(
      `startOfDayInTz failed for ${date.toISOString()} / ${tz}`,
    );
  }
  return start;
}

function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 86_400_000);
}

const CRITICAL_KEYWORDS = [
  "medicina",
  "medicación",
  "pastilla",
  "pastillas",
  "vitamina",
  "dosis",
  "vacuna",
  "vuelo",
  "avión",
  "tren",
  "viaje",
  "examen",
  "prueba",
  "test",
  "oposición",
  "entrevista",
  "médico",
  "dentista",
  "doctor",
  "hospital",
  "cita",
  "revisión",
  "entrega",
  "deadline",
  "plazo",
  "factura",
  "pago",
  "vencimiento",
  "cumpleaños",
  "aniversario",
  "boda",
  "importante",
  "urgente",
  "crítico",
];

function hasCriticalKeywords(content: string): boolean {
  const lower = content.toLowerCase();
  return CRITICAL_KEYWORDS.some((kw) => lower.includes(kw));
}

function isInDndWindow(timezone: string): boolean {
  const hourStr = formatInTimeZone(new Date(), timezone, "HH");
  const hour = Number.parseInt(hourStr, 10);
  return hour >= 23 || hour < 7;
}

function getNextDndEnd(timezone: string): string {
  const now = new Date();
  const hourStr = formatInTimeZone(now, timezone, "HH");
  const hour = Number.parseInt(hourStr, 10);

  const ymd = hour >= 23
    ? formatInTimeZone(addDays(now, 1), timezone, "yyyy-MM-dd")
    : formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const offset = formatInTimeZone(now, timezone, "xxx");
  return new Date(`${ymd}T07:00:00${offset === "Z" ? "+00:00" : offset}`)
    .toISOString();
}

async function buildDeliveryMessage(
  content: string,
  timezone: string,
  isCritical: boolean,
): Promise<string> {
  const localTime = formatInTimeZone(new Date(), timezone, "HH:mm");

  let body: string | null = null;
  try {
    const mod = await import("../_shared/deepseek.ts");
    if (typeof mod.composeReminderDelivery === "function") {
      body = await mod.composeReminderDelivery(content, localTime, isCritical);
    }
  } catch (err) {
    safeLog("warn", "compose_delivery_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!body) {
    const hour = Number.parseInt(
      formatInTimeZone(new Date(), timezone, "HH"),
      10,
    );
    let greeting = "";
    if (hour >= 6 && hour < 12) greeting = "Good morning.";
    else if (hour >= 12 && hour < 18) greeting = "Good afternoon.";
    else if (hour >= 18 && hour < 22) greeting = "Good evening.";
    else greeting = "Aviso rápido.";
    body = `${greeting} A las ${localTime}: ${content}`;
  }

  const urgencyPrefix = isCritical ? "🚨 " : "";
  const ackLine = '\n\nResponde "hecho" cuando lo termines.';
  return `${urgencyPrefix}${body}${ackLine}`;
}

async function createPendingAck(
  reminderId: string,
  isCritical: boolean,
): Promise<void> {
  const nudgeDelayMs = isCritical ? 30 * 60_000 : 60 * 60_000;
  const { error } = await db
    .from("pending_ack")
    .insert({
      reminder_id: reminderId,
      next_nudge_at: new Date(Date.now() + nudgeDelayMs).toISOString(),
      is_critical: isCritical,
      max_nudges: isCritical ? 5 : 2,
    });
  if (error) {
    safeLog("warn", "pending_ack_insert_failed", {
      reminder_id: reminderId,
      error: error.message,
    });
  }
}

async function processNudges(): Promise<void> {
  const { data, error } = await db.rpc("select_due_nudges");
  if (error || !data) return;

  const nudges = data as Array<{
    id: string;
    reminder_id: string;
    nudge_count: number;
    max_nudges: number;
    is_critical: boolean;
  }>;

  for (const nudge of nudges) {
    try {
      const reminder = await loadReminder(nudge.reminder_id);
      if (
        !reminder || reminder.status === "completed" ||
        reminder.status === "cancelled"
      ) {
        await db.from("pending_ack").update({
          acknowledged_at: new Date().toISOString(),
        }).eq("id", nudge.id);
        continue;
      }

      const content = reminder.content?.trim() ?? "recordatorio pendiente";
      const attempt = nudge.nudge_count + 1;
      const emoji = nudge.is_critical ? "🚨" : "🔔";
      const message =
        `${emoji} Insisto (${attempt}/${nudge.max_nudges})\n\n${content}`;
      await sendMessage(OWNER_CHAT_ID, message);

      const nextDelay = (nudge.is_critical ? 30 : 60) * 60_000 *
        (1 + attempt * 0.5);
      await db.from("pending_ack").update({
        nudge_count: attempt,
        next_nudge_at: new Date(Date.now() + nextDelay).toISOString(),
      }).eq("id", nudge.id);

      safeLog("info", "nudge_sent", {
        reminder_id: nudge.reminder_id,
        attempt,
      });
    } catch (err) {
      safeLog("error", "nudge_failed", {
        nudge_id: nudge.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function morningHello(tz: string): string {
  const hour = Number(formatInTimeZone(new Date(), tz, "HH"));
  if (hour >= 5 && hour < 12) return "🌅 Good morning.";
  if (hour >= 12 && hour < 18) return "👋 Hi.";
  if (hour >= 18 && hour < 22) return "🌇 Good evening.";
  return "🌙 Hello.";
}

function nightlyHello(tz: string): string {
  const hour = Number(formatInTimeZone(new Date(), tz, "HH"));
  if (hour >= 22 || hour < 5) return "🌙 Good night.";
  if (hour >= 18) return "🌇 Good evening.";
  if (hour >= 12) return "👋 Hi.";
  return "🌅 Good morning.";
}
