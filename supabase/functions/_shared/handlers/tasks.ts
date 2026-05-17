import { db, safeLog } from "../supabase.ts";
import type {
  IntentEnvelope,
  ReminderRow,
  ReminderStatus,
  StopCondition,
  TaskRow,
  TaskStatus,
} from "../types.ts";

const AUTO_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function handleCreateTask(
  envelope: IntentEnvelope,
): Promise<string> {
  const title = envelope.entities.content?.trim();
  if (!title) {
    throw new Error("create_task requires entities.content");
  }

  const dueAtIso = envelope.entities.deadline_at?.trim();
  const dueAt = dueAtIso ? parseIsoDate(dueAtIso, "deadline_at") : null;
  const tags = normalizeTags(envelope.entities.tags);
  const priority = derivePriority(envelope);

  const { data: taskData, error: taskErr } = await db
    .from("task")
    .insert({
      title,
      due_at: dueAt ? dueAt.toISOString() : null,
      priority,
      tags,
      status: "pending" satisfies TaskStatus,
    })
    .select()
    .single();
  if (taskErr || !taskData) {
    throw new Error(
      `handleCreateTask insert failed: ${taskErr?.message ?? "no row"}`,
    );
  }
  const task = taskData as TaskRow;
  safeLog("info", "task_op", { op: "create_task", task_id: task.id });

  let suffix = "";
  if (dueAt) {
    const msUntilDue = dueAt.getTime() - Date.now();
    if (msUntilDue > 0 && msUntilDue < AUTO_REMINDER_WINDOW_MS) {
      const reminderId = await insertAutoReminder(task, dueAt);
      const hours = Math.max(1, Math.round(msUntilDue / (60 * 60 * 1000)));
      suffix = ` (con recordatorio en ${hours} ${
        hours === 1 ? "hora" : "horas"
      })`;
      safeLog("info", "reminder_op", {
        op: "auto_create_for_task",
        task_id: task.id,
        reminder_id: reminderId,
      });
    }
  }

  return `Tarea creada: «${task.title}»${suffix}`;
}

export async function handleCompleteTask(
  envelope: IntentEnvelope,
): Promise<string> {
  const task = await resolveTask(envelope, "pending");

  const { error: updateErr } = await db
    .from("task")
    .update({
      status: "completed" satisfies TaskStatus,
      completed_at: new Date().toISOString(),
    })
    .eq("id", task.id);
  if (updateErr) {
    throw new Error(`handleCompleteTask update failed: ${updateErr.message}`);
  }
  safeLog("info", "task_op", { op: "complete_task", task_id: task.id });

  const stopped = await stopLinkedEscalations(task.id);

  let suffix = "";
  if (stopped > 0) {
    suffix = ` Detuve ${stopped} ${
      stopped === 1 ? "recordatorio escalado" : "recordatorios escalados"
    }.`;
  }
  return `Tarea completada: «${task.title}».${suffix}`;
}

async function insertAutoReminder(
  task: TaskRow,
  dueAt: Date,
): Promise<string> {
  const { data, error } = await db
    .from("reminder")
    .insert({
      kind: "static",
      status: "scheduled" satisfies ReminderStatus,
      content: `Recordatorio: ${task.title}`,
      next_trigger_at: dueAt.toISOString(),
      linked_task_id: task.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertAutoReminder failed: ${error?.message ?? "no row"}`,
    );
  }
  return (data as { id: string }).id;
}

async function stopLinkedEscalations(taskId: string): Promise<number> {
  const { data, error } = await db
    .from("reminder")
    .select("*")
    .eq("linked_task_id", taskId)
    .in("status", ["scheduled", "active"]);
  if (error) {
    throw new Error(`stopLinkedEscalations select failed: ${error.message}`);
  }
  const candidates = (data ?? []) as ReminderRow[];

  const targets = candidates.filter((r) => {
    const sc = r.stop_condition as StopCondition | null;
    return sc?.type === "task_completed";
  });
  if (targets.length === 0) {
    return 0;
  }

  const ids = targets.map((r) => r.id);
  const { error: updateErr } = await db
    .from("reminder")
    .update({
      status: "completed" satisfies ReminderStatus,
      next_trigger_at: null,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);
  if (updateErr) {
    throw new Error(
      `stopLinkedEscalations update failed: ${updateErr.message}`,
    );
  }
  for (const id of ids) {
    safeLog("info", "reminder_op", {
      op: "escalation_stopped_by_task",
      reminder_id: id,
      task_id: taskId,
    });
  }
  return ids.length;
}

async function resolveTask(
  envelope: IntentEnvelope,
  preferStatus?: TaskStatus,
): Promise<TaskRow> {
  const directId = envelope.entities.task_id?.trim();
  if (directId) {
    const { data, error } = await db
      .from("task")
      .select("*")
      .eq("id", directId)
      .maybeSingle();
    if (error) {
      throw new Error(`resolveTask direct lookup failed: ${error.message}`);
    }
    if (!data) {
      throw new Error(`No encuentro la tarea con id ${directId}.`);
    }
    return data as TaskRow;
  }

  const content = envelope.entities.content?.trim();
  if (!content) {
    throw new Error("No puedo identificar la tarea (falta content o task_id).");
  }

  let query = db
    .from("task")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (preferStatus) {
    query = query.eq("status", preferStatus);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`resolveTask scan failed: ${error.message}`);
  }
  const candidates = (data ?? []) as TaskRow[];

  const lower = content.toLowerCase();
  const match = candidates.find((t) => t.title.toLowerCase().includes(lower)) ??
    candidates.find((t) => lower.includes(t.title.toLowerCase()));
  if (!match) {
    throw new Error(`No encontré ninguna tarea que contenga «${content}».`);
  }
  return match;
}

function parseIsoDate(input: string, field: string): Date {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO 8601 in ${field}: ${input}`);
  }
  return d;
}

function normalizeTags(input: string[] | undefined): string[] {
  if (!input) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function derivePriority(envelope: IntentEnvelope): number {
  const tags = envelope.entities.tags ?? [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const m = tag.match(/^priority[:=]?(\d)$/i);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 5) return n;
    }
  }
  return 3;
}
