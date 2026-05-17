import { db, safeLog } from "../supabase.ts";
import { computeNextTrigger, parseRRule, summarizeRRule } from "../rrule.ts";
import { formatInTimeZone } from "date-fns-tz";
import type {
  ConditionPredicate,
  EscalationRule,
  IntentEnvelope,
  PreNotification,
  ReminderKind,
  ReminderRow,
  ReminderStatus,
  StopCondition,
  TemplateId,
  ThenAction,
} from "../types.ts";

const VALID_TEMPLATES: readonly TemplateId[] = [
  "daily_briefing",
  "tomorrow_agenda",
  "weekly_review",
  "pending_tasks",
  "next_calendar_event",
] as const;

const OPEN_STATUSES: readonly ReminderStatus[] = [
  "scheduled",
  "active",
  "paused",
] as const;

const WEEKDAYS_ES: readonly string[] = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];

const MONTHS_ES: readonly string[] = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

export async function handleCreateReminder(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const kind: ReminderKind = envelope.reminder_kind ?? "static";
  switch (kind) {
    case "static":
      return createStaticReminder(envelope, ownerTimezone);
    case "recurring":
      return createRecurringReminder(envelope, ownerTimezone);
    case "dynamic":
      return createDynamicReminder(envelope, ownerTimezone);
    case "conditional":
      return createConditionalReminder(envelope, ownerTimezone);
    case "escalation":
      return createEscalationReminder(envelope, ownerTimezone);
    case "composite":
      return createCompositeReminder(envelope, ownerTimezone);
    default: {
      const exhaustive: never = kind;
      throw new Error(
        `handleCreateReminder: unsupported reminder_kind: ${
          String(exhaustive)
        }`,
      );
    }
  }
}

export async function createStaticReminder(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const content = envelope.entities.content?.trim();
  if (!content) {
    throw new Error("create_reminder (static) requires entities.content");
  }
  const triggerIso = envelope.entities.trigger_at?.trim();
  if (!triggerIso) {
    throw new Error("create_reminder (static) requires entities.trigger_at");
  }
  let triggerAt = parseIso(triggerIso, "trigger_at");

  const nowMs = Date.now();
  if (triggerAt.getTime() <= nowMs) {
    if (triggerAt.getTime() > nowMs - 60_000) {
      triggerAt = new Date(nowMs + 10_000);
    } else {
      throw new Error(
        "No puedo crear el recordatorio: la fecha indicada está en el pasado.",
      );
    }
  }

  const parent = await insertReminderRow({
    kind: "static",
    status: "scheduled",
    content,
    raw_text: envelope.raw_text ?? null,
    next_trigger_at: triggerAt.toISOString(),
    timezone: ownerTimezone,
  });
  safeLog("info", "reminder_op", {
    op: "create_static",
    kind: "static",
    reminder_id: parent.id,
  });

  const preNotifications = envelope.entities.pre_notifications ?? [];
  let preCreated = 0;
  for (const pn of preNotifications) {
    const childId = await insertPreNotification(
      pn,
      parent.id,
      triggerAt,
      ownerTimezone,
    );
    if (childId !== null) {
      preCreated += 1;
      safeLog("info", "reminder_op", {
        op: "create_pre_notification",
        kind: "static",
        reminder_id: childId,
        parent_reminder_id: parent.id,
      });
    }
  }

  const localized = formatDateInTz(triggerAt, ownerTimezone);
  const suffix = preCreated > 0
    ? ` Con ${preCreated} pre-aviso${preCreated === 1 ? "" : "s"}.`
    : "";
  const inferredNote = envelope.entities.trigger_at_confidence === "inferred"
    ? "\n\n_(He asumido la hora; si querías otra, dímelo.)_"
    : "";
  return `⏰ Listo, te aviso ${localized}:\n\n«${content}»${suffix}${inferredNote}\n\n_No te preocupes, yo me encargo._`;
}

async function insertPreNotification(
  pn: PreNotification,
  parentId: string,
  parentTrigger: Date,
  ownerTimezone: string,
): Promise<string | null> {
  if (typeof pn.lead_time_minutes !== "number" || pn.lead_time_minutes <= 0) {
    throw new Error(
      "pre_notifications[*].lead_time_minutes must be a positive integer",
    );
  }
  const childContent = (pn.content_template ?? "").trim();
  if (!childContent) {
    throw new Error("pre_notifications[*].content_template must be non-empty");
  }
  const childTrigger = new Date(
    parentTrigger.getTime() - pn.lead_time_minutes * 60_000,
  );
  if (childTrigger.getTime() <= Date.now()) {
    return null;
  }

  const child = await insertReminderRow({
    kind: "static",
    status: "scheduled",
    content: childContent,
    next_trigger_at: childTrigger.toISOString(),
    parent_reminder_id: parentId,
    timezone: ownerTimezone,
  });
  return child.id;
}

export async function createRecurringReminder(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const content = envelope.entities.content?.trim();
  if (!content) {
    throw new Error("create_reminder (recurring) requires entities.content");
  }
  const rrule = envelope.entities.recurrence_rule?.trim();
  if (!rrule) {
    throw new Error(
      "create_reminder (recurring) requires entities.recurrence_rule",
    );
  }

  const now = new Date();
  let nextTrigger: Date | null;
  try {
    const rule = parseRRule(rrule, now, ownerTimezone);
    nextTrigger = rule.after(now, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `No entendí la recurrencia: ${msg}`;
  }
  if (!nextTrigger) {
    return "No entendí la recurrencia: la regla no produce ocurrencias futuras.";
  }

  const reminder = await insertReminderRow({
    kind: "recurring",
    status: "active",
    content,
    raw_text: envelope.raw_text ?? null,
    recurrence_rule: rrule,
    start_at: now.toISOString(),
    next_trigger_at: nextTrigger.toISOString(),
    timezone: ownerTimezone,
  });
  safeLog("info", "reminder_op", {
    op: "create_recurring",
    kind: "recurring",
    reminder_id: reminder.id,
  });

  let summary: { description: string; nextOccurrences: string[] };
  try {
    summary = summarizeRRule(rrule, now, ownerTimezone);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `🔁 Recordatorio recurrente creado: «${content}». (No pude generar la previsualización: ${msg})`;
  }

  const lines: string[] = [
    `🔁 Hecho. Te recordaré «${content}» de forma recurrente.`,
    `📋 ${summary.description}.`,
    ``,
    `Próximas entregas:`,
    ...summary.nextOccurrences.map((occ) => `• ${occ}`),
    ``,
    `_Dime \"pausa\" o \"cancela\" cuando quieras pararlo._`,
  ];
  return lines.join("\n");
}

export async function createDynamicReminder(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const templateId = envelope.entities.template_id;
  if (!templateId || !isValidTemplate(templateId)) {
    throw new Error(
      `create_reminder (dynamic) requires a valid template_id; got: ${
        String(templateId ?? "")
      }`,
    );
  }
  const templateParams = envelope.entities.template_params ?? {};

  const rrule = envelope.entities.recurrence_rule?.trim();
  const triggerIso = envelope.entities.trigger_at?.trim();
  const now = new Date();

  let nextTrigger: Date;
  let startAtIso: string | null = null;
  if (rrule) {
    try {
      const rule = parseRRule(rrule, now, ownerTimezone);
      const after = rule.after(now, true);
      if (!after) {
        return "No entendí la recurrencia: la regla no produce ocurrencias futuras.";
      }
      nextTrigger = after;
      startAtIso = now.toISOString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `No entendí la recurrencia: ${msg}`;
    }
  } else if (triggerIso) {
    nextTrigger = parseIso(triggerIso, "trigger_at");
    if (nextTrigger.getTime() <= Date.now()) {
      throw new Error(
        "No puedo crear el recordatorio dinámico: la fecha indicada está en el pasado.",
      );
    }
  } else {
    throw new Error(
      "create_reminder (dynamic) requires recurrence_rule or trigger_at",
    );
  }

  const reminder = await insertReminderRow({
    kind: "dynamic",
    status: "active",
    raw_text: envelope.raw_text ?? null,
    template_id: templateId,
    template_params: templateParams,
    recurrence_rule: rrule ?? null,
    start_at: startAtIso,
    next_trigger_at: nextTrigger.toISOString(),
    timezone: ownerTimezone,
  });
  safeLog("info", "reminder_op", {
    op: "create_dynamic",
    kind: "dynamic",
    reminder_id: reminder.id,
  });

  const localized = formatDateInTz(nextTrigger, ownerTimezone);
  return `📊 Recordatorio dinámico creado: «${templateId}» para ${localized}.`;
}

export async function createConditionalReminder(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const condition = envelope.entities.condition;
  if (!condition || typeof condition !== "object") {
    throw new Error(
      "create_reminder (conditional) requires entities.condition",
    );
  }
  if (!condition.predicate_type) {
    throw new Error(
      "create_reminder (conditional) requires entities.condition.predicate_type",
    );
  }
  const thenAction = envelope.entities.then_action;
  if (!thenAction || typeof thenAction !== "object") {
    throw new Error(
      "create_reminder (conditional) requires entities.then_action",
    );
  }
  const triggerIso = envelope.entities.trigger_at?.trim();
  if (!triggerIso) {
    throw new Error(
      "create_reminder (conditional) requires entities.trigger_at",
    );
  }
  const triggerAt = parseIso(triggerIso, "trigger_at");
  if (triggerAt.getTime() <= Date.now()) {
    throw new Error(
      "No puedo crear el recordatorio condicional: la fecha de evaluación está en el pasado.",
    );
  }

  const reEvaluationRule = envelope.entities.re_evaluation_rule?.trim() ?? null;
  if (reEvaluationRule) {
    try {
      parseRRule(reEvaluationRule, triggerAt, ownerTimezone);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `No entendí la regla de re-evaluación: ${msg}`;
    }
  }

  const reminder = await insertReminderRow({
    kind: "conditional",
    status: "scheduled",
    content: envelope.entities.content?.trim() ?? null,
    raw_text: envelope.raw_text ?? null,
    condition: condition as ConditionPredicate,
    then_action: thenAction as ThenAction,
    re_evaluation_rule: reEvaluationRule,
    next_trigger_at: triggerAt.toISOString(),
    timezone: ownerTimezone,
  });
  safeLog("info", "reminder_op", {
    op: "create_conditional",
    kind: "conditional",
    reminder_id: reminder.id,
  });

  const localized = formatDateInTz(triggerAt, ownerTimezone);
  return `🧪 Recordatorio condicional creado. Se evaluará en ${localized}.`;
}

export async function createEscalationReminder(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const escalationRule = envelope.entities.escalation_rule;
  if (!escalationRule || typeof escalationRule !== "object") {
    throw new Error(
      "create_reminder (escalation) requires entities.escalation_rule",
    );
  }
  if (!escalationRule.policy) {
    throw new Error(
      "create_reminder (escalation) requires escalation_rule.policy",
    );
  }
  const stopCondition = envelope.entities.stop_condition;
  if (!stopCondition || typeof stopCondition !== "object") {
    throw new Error(
      "create_reminder (escalation) requires entities.stop_condition",
    );
  }

  const content = envelope.entities.content?.trim();
  if (!content) {
    throw new Error("create_reminder (escalation) requires entities.content");
  }

  const now = new Date();
  let nextTrigger: Date;
  if (escalationRule.policy === "recur_until_completed") {
    const rrule = escalationRule.recurrence_rule?.trim();
    if (!rrule) {
      throw new Error(
        "escalation_rule.policy=recur_until_completed requires recurrence_rule",
      );
    }
    let after: Date | null;
    try {
      const rule = parseRRule(rrule, now, ownerTimezone);
      after = rule.after(now, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `No entendí la recurrencia del escalado: ${msg}`;
    }
    if (!after) {
      return "No entendí el escalado: la regla no produce ocurrencias futuras.";
    }
    nextTrigger = after;
  } else if (escalationRule.policy === "repeat_after_delay") {
    const triggerIso = envelope.entities.trigger_at?.trim();
    if (triggerIso) {
      const triggerAt = parseIso(triggerIso, "trigger_at");
      if (triggerAt.getTime() <= Date.now()) {
        throw new Error(
          "No puedo crear el recordatorio escalado: la fecha inicial está en el pasado.",
        );
      }
      nextTrigger = triggerAt;
    } else {
      const interval = escalationRule.interval_minutes;
      if (typeof interval !== "number" || interval <= 0) {
        throw new Error(
          "escalation_rule.policy=repeat_after_delay requires interval_minutes (or trigger_at)",
        );
      }
      nextTrigger = new Date(now.getTime() + interval * 60_000);
    }
  } else {
    const exhaustive: never = escalationRule.policy;
    throw new Error(
      `escalation_rule.policy not supported: ${String(exhaustive)}`,
    );
  }

  const reminder = await insertReminderRow({
    kind: "escalation",
    status: "active",
    content,
    raw_text: envelope.raw_text ?? null,
    escalation_rule: escalationRule as EscalationRule,
    stop_condition: stopCondition as StopCondition,
    linked_task_id: envelope.entities.task_id ?? null,
    linked_list_item_id: envelope.entities.list_item_id ?? null,
    next_trigger_at: nextTrigger.toISOString(),
    timezone: ownerTimezone,
  });
  safeLog("info", "reminder_op", {
    op: "create_escalation",
    kind: "escalation",
    reminder_id: reminder.id,
  });

  const localized = formatDateInTz(nextTrigger, ownerTimezone);
  return `⚠️ Recordatorio escalado creado: «${content}». Primer aviso en ${localized}.`;
}

export async function createCompositeReminder(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const components = envelope.entities.components ?? [];
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error(
      "create_reminder (composite) requires a non-empty entities.components array",
    );
  }
  const parentContent = envelope.entities.content?.trim() ?? null;

  const parent = await insertReminderRow({
    kind: "composite",
    status: "active",
    content: parentContent,
    raw_text: envelope.raw_text ?? null,
    timezone: ownerTimezone,
  });
  safeLog("info", "reminder_op", {
    op: "create_composite_parent",
    kind: "composite",
    reminder_id: parent.id,
  });

  const childSummaries: string[] = [];
  try {
    for (const child of components) {
      const summary = await insertCompositeChild(
        child,
        parent.id,
        ownerTimezone,
      );
      childSummaries.push(summary);
    }
  } catch (err) {
    await db.from("reminder").delete().eq("id", parent.id);
    throw err;
  }

  const lines: string[] = [
    `🧩 Recordatorio compuesto creado con ${childSummaries.length} parte${
      childSummaries.length === 1 ? "" : "s"
    }${parentContent ? `: «${parentContent}»` : ""}`,
    ...childSummaries.map((s) => `• ${s}`),
  ];
  return lines.join("\n");
}

async function insertCompositeChild(
  child: IntentEnvelope,
  parentId: string,
  ownerTimezone: string,
): Promise<string> {
  const kind: ReminderKind = child.reminder_kind ?? "static";
  const e = child.entities;

  switch (kind) {
    case "static": {
      const content = e.content?.trim();
      if (!content) {
        throw new Error("composite child (static) requires entities.content");
      }
      const triggerIso = e.trigger_at?.trim();
      if (!triggerIso) {
        throw new Error(
          "composite child (static) requires entities.trigger_at",
        );
      }
      const triggerAt = parseIso(triggerIso, "trigger_at");
      if (triggerAt.getTime() <= Date.now()) {
        throw new Error(
          `composite child (static): trigger_at en el pasado para «${content}»`,
        );
      }
      const row = await insertReminderRow({
        kind: "static",
        status: "scheduled",
        content,
        next_trigger_at: triggerAt.toISOString(),
        parent_reminder_id: parentId,
        timezone: ownerTimezone,
      });
      safeLog("info", "reminder_op", {
        op: "create_composite_child",
        kind: "static",
        reminder_id: row.id,
        parent_reminder_id: parentId,
      });
      return `⏰ «${content}» — ${formatDateInTz(triggerAt, ownerTimezone)}`;
    }

    case "recurring": {
      const content = e.content?.trim();
      if (!content) {
        throw new Error(
          "composite child (recurring) requires entities.content",
        );
      }
      const rrule = e.recurrence_rule?.trim();
      if (!rrule) {
        throw new Error(
          "composite child (recurring) requires entities.recurrence_rule",
        );
      }
      const now = new Date();
      const rule = parseRRule(rrule, now, ownerTimezone);
      const after = rule.after(now, true);
      if (!after) {
        throw new Error(
          `composite child (recurring): la regla no produce ocurrencias para «${content}»`,
        );
      }
      const row = await insertReminderRow({
        kind: "recurring",
        status: "active",
        content,
        recurrence_rule: rrule,
        start_at: now.toISOString(),
        next_trigger_at: after.toISOString(),
        parent_reminder_id: parentId,
        timezone: ownerTimezone,
      });
      safeLog("info", "reminder_op", {
        op: "create_composite_child",
        kind: "recurring",
        reminder_id: row.id,
        parent_reminder_id: parentId,
      });
      return `🔁 «${content}» — primera ocurrencia ${
        formatDateInTz(after, ownerTimezone)
      }`;
    }

    case "dynamic": {
      const templateId = e.template_id;
      if (!templateId || !isValidTemplate(templateId)) {
        throw new Error(
          "composite child (dynamic) requires a valid template_id",
        );
      }
      const rrule = e.recurrence_rule?.trim();
      const triggerIso = e.trigger_at?.trim();
      const now = new Date();
      let nextTrigger: Date;
      let startAtIso: string | null = null;
      if (rrule) {
        const rule = parseRRule(rrule, now, ownerTimezone);
        const after = rule.after(now, true);
        if (!after) {
          throw new Error(
            "composite child (dynamic): la regla no produce ocurrencias",
          );
        }
        nextTrigger = after;
        startAtIso = now.toISOString();
      } else if (triggerIso) {
        nextTrigger = parseIso(triggerIso, "trigger_at");
        if (nextTrigger.getTime() <= Date.now()) {
          throw new Error(
            "composite child (dynamic): trigger_at en el pasado",
          );
        }
      } else {
        throw new Error(
          "composite child (dynamic) requires recurrence_rule or trigger_at",
        );
      }
      const row = await insertReminderRow({
        kind: "dynamic",
        status: "active",
        template_id: templateId,
        template_params: e.template_params ?? {},
        recurrence_rule: rrule ?? null,
        start_at: startAtIso,
        next_trigger_at: nextTrigger.toISOString(),
        parent_reminder_id: parentId,
        timezone: ownerTimezone,
      });
      safeLog("info", "reminder_op", {
        op: "create_composite_child",
        kind: "dynamic",
        reminder_id: row.id,
        parent_reminder_id: parentId,
      });
      return `📊 «${templateId}» — ${
        formatDateInTz(nextTrigger, ownerTimezone)
      }`;
    }

    case "conditional": {
      const condition = e.condition;
      const thenAction = e.then_action;
      const triggerIso = e.trigger_at?.trim();
      if (!condition || !thenAction || !triggerIso) {
        throw new Error(
          "composite child (conditional) requires condition, then_action and trigger_at",
        );
      }
      const triggerAt = parseIso(triggerIso, "trigger_at");
      if (triggerAt.getTime() <= Date.now()) {
        throw new Error(
          "composite child (conditional): trigger_at en el pasado",
        );
      }
      const row = await insertReminderRow({
        kind: "conditional",
        status: "scheduled",
        content: e.content?.trim() ?? null,
        condition: condition as ConditionPredicate,
        then_action: thenAction as ThenAction,
        re_evaluation_rule: e.re_evaluation_rule?.trim() ?? null,
        next_trigger_at: triggerAt.toISOString(),
        parent_reminder_id: parentId,
        timezone: ownerTimezone,
      });
      safeLog("info", "reminder_op", {
        op: "create_composite_child",
        kind: "conditional",
        reminder_id: row.id,
        parent_reminder_id: parentId,
      });
      return `🧪 evaluación en ${formatDateInTz(triggerAt, ownerTimezone)}`;
    }

    case "escalation": {
      const escalationRule = e.escalation_rule;
      const stopCondition = e.stop_condition;
      const content = e.content?.trim();
      if (!escalationRule || !stopCondition || !content) {
        throw new Error(
          "composite child (escalation) requires escalation_rule, stop_condition and content",
        );
      }
      const now = new Date();
      let nextTrigger: Date;
      if (escalationRule.policy === "recur_until_completed") {
        const rrule = escalationRule.recurrence_rule?.trim();
        if (!rrule) {
          throw new Error(
            "composite child (escalation): policy recur_until_completed requires recurrence_rule",
          );
        }
        const rule = parseRRule(rrule, now, ownerTimezone);
        const after = rule.after(now, true);
        if (!after) {
          throw new Error(
            "composite child (escalation): regla sin ocurrencias futuras",
          );
        }
        nextTrigger = after;
      } else {
        const triggerIso = e.trigger_at?.trim();
        if (triggerIso) {
          nextTrigger = parseIso(triggerIso, "trigger_at");
          if (nextTrigger.getTime() <= Date.now()) {
            throw new Error(
              "composite child (escalation): trigger_at en el pasado",
            );
          }
        } else {
          const interval = escalationRule.interval_minutes;
          if (typeof interval !== "number" || interval <= 0) {
            throw new Error(
              "composite child (escalation): falta interval_minutes o trigger_at",
            );
          }
          nextTrigger = new Date(now.getTime() + interval * 60_000);
        }
      }
      const row = await insertReminderRow({
        kind: "escalation",
        status: "active",
        content,
        escalation_rule: escalationRule as EscalationRule,
        stop_condition: stopCondition as StopCondition,
        linked_task_id: e.task_id ?? null,
        linked_list_item_id: e.list_item_id ?? null,
        next_trigger_at: nextTrigger.toISOString(),
        parent_reminder_id: parentId,
        timezone: ownerTimezone,
      });
      safeLog("info", "reminder_op", {
        op: "create_composite_child",
        kind: "escalation",
        reminder_id: row.id,
        parent_reminder_id: parentId,
      });
      return `⚠️ «${content}» — ${formatDateInTz(nextTrigger, ownerTimezone)}`;
    }

    case "composite":
      throw new Error("composite child cannot itself be composite");

    default: {
      const exhaustive: never = kind;
      throw new Error(
        `composite child has unsupported kind: ${String(exhaustive)}`,
      );
    }
  }
}

export async function handleCancelReminder(
  envelope: IntentEnvelope,
): Promise<string> {
  const raw = (envelope.raw_text ?? "").toLowerCase();
  const content = envelope.entities.content?.toLowerCase().trim() ?? "";
  const hasNoSpecificTarget = !envelope.entities.reminder_id &&
    !envelope.entities.short_id &&
    (content === "" ||
      content === "todos" || content === "todo" || content === "todas" ||
      /^todos? (los )?recordatorios?$/.test(content) ||
      /^todas? (las )?alertas?$/.test(content));
  const rawSaysAll =
    /\btodos?\s+(los\s+)?(mis\s+)?(recordatorios?|alertas?|avisos?)\b/.test(
      raw,
    ) ||
    /\b(borra|elimina|cancela|quita)\s+todo\b/.test(raw);

  if (hasNoSpecificTarget && rawSaysAll) {
    return await cancelAllOpenReminders();
  }

  const target = await resolveReminder(envelope);
  await transitionReminder(target.id, "cancelled", { clearTrigger: true });

  const cascaded = await cascadeChildStatus(target.id, "cancelled", {
    clearTrigger: true,
  });

  safeLog("info", "reminder_op", {
    op: "cancel_reminder",
    kind: target.kind,
    reminder_id: target.id,
    cascaded,
  });

  const label = describeReminder(target);
  const suffix = cascaded > 0
    ? ` (${cascaded} ${cascaded === 1 ? "hijo cancelado" : "hijos cancelados"})`
    : "";
  return `🚫 Recordatorio cancelado: ${label}.${suffix}`;
}

async function cancelAllOpenReminders(): Promise<string> {
  const { data, error } = await db
    .from("reminder")
    .update({
      status: "cancelled",
      next_trigger_at: null,
      updated_at: new Date().toISOString(),
    })
    .in("status", OPEN_STATUSES as unknown as string[])
    .select("id");
  if (error) {
    throw new Error(`cancelAllOpenReminders failed: ${error.message}`);
  }
  const total = (data ?? []).length;

  if (total > 0) {
    const ids = (data as Array<{ id: string }>).map((r) => r.id);
    await db
      .from("job_outbox")
      .delete()
      .in("status", ["pending", "in_flight"])
      .in("reminder_id", ids);
  }

  safeLog("info", "reminder_op", {
    op: "cancel_all",
    total,
  });

  if (total === 0) {
    return "No tienes recordatorios activos para borrar.";
  }
  return `🗑️ Borrados ${total} ${
    total === 1 ? "recordatorio" : "recordatorios"
  }.`;
}

export async function handlePauseReminder(
  envelope: IntentEnvelope,
): Promise<string> {
  const target = await resolveReminder(envelope);
  if (target.status === "paused") {
    return `⏸ El recordatorio ya estaba pausado: ${describeReminder(target)}.`;
  }
  await transitionReminder(target.id, "paused");
  const cascaded = await cascadeChildStatus(target.id, "paused");

  safeLog("info", "reminder_op", {
    op: "pause_reminder",
    kind: target.kind,
    reminder_id: target.id,
    cascaded,
  });

  const suffix = cascaded > 0
    ? ` (${cascaded} ${cascaded === 1 ? "hijo pausado" : "hijos pausados"})`
    : "";
  return `⏸ Recordatorio pausado: ${describeReminder(target)}.${suffix}`;
}

export async function handleResumeReminder(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const target = await resolveReminder(envelope);
  if (target.status !== "paused") {
    return `El recordatorio no está pausado: ${describeReminder(target)}.`;
  }

  const newStatus: ReminderStatus = target.kind === "static" ||
      target.kind === "conditional"
    ? "scheduled"
    : "active";

  let newTrigger: string | null = target.next_trigger_at;
  const now = new Date();
  if (
    target.kind === "recurring" ||
    target.kind === "dynamic" ||
    target.kind === "escalation" ||
    (target.kind === "conditional" && target.re_evaluation_rule)
  ) {
    try {
      const next = computeNextTrigger(
        { ...target, timezone: target.timezone ?? ownerTimezone },
        now,
      );
      newTrigger = next ? next.toISOString() : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`No pude reagendar el recordatorio: ${msg}`);
    }
  }

  await applyReminderUpdate(target.id, {
    status: newStatus,
    next_trigger_at: newTrigger,
  });

  const cascaded = await cascadeChildStatus(target.id, newStatus);

  safeLog("info", "reminder_op", {
    op: "resume_reminder",
    kind: target.kind,
    reminder_id: target.id,
    cascaded,
  });

  return `▶️ Recordatorio reanudado: ${describeReminder(target)}.`;
}

export async function handleUpdateReminder(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const target = await resolveReminder(envelope);

  const updates: Record<string, unknown> = {};
  let changed = false;

  const newContent = envelope.entities.content?.trim();
  if (newContent && newContent !== target.content) {
    updates.content = newContent;
    changed = true;
  }

  const newTriggerIso = envelope.entities.trigger_at?.trim();
  let newTrigger: Date | null = null;
  if (newTriggerIso) {
    newTrigger = parseIso(newTriggerIso, "trigger_at");
    if (newTrigger.getTime() <= Date.now()) {
      throw new Error(
        "No puedo actualizar el recordatorio: la nueva fecha está en el pasado.",
      );
    }
    updates.next_trigger_at = newTrigger.toISOString();
    changed = true;
  }

  if (!changed) {
    throw new Error(
      "No hay cambios que aplicar: indica un nuevo content o trigger_at.",
    );
  }

  await applyReminderUpdate(target.id, updates);

  safeLog("info", "reminder_op", {
    op: "update_reminder",
    kind: target.kind,
    reminder_id: target.id,
  });

  const newSummary = newTrigger
    ? ` (nueva fecha: ${formatDateInTz(newTrigger, ownerTimezone)})`
    : "";
  return `✏️ Recordatorio actualizado: ${
    describeReminder({
      ...target,
      content: newContent ?? target.content,
      next_trigger_at: updates.next_trigger_at as string | null ??
        target.next_trigger_at,
    })
  }.${newSummary}`;
}

export async function handleListReminders(): Promise<string> {
  const { data, error } = await db
    .from("reminder")
    .select("*")
    .in("status", ["scheduled", "active", "paused"])
    .order("next_trigger_at", { ascending: true, nullsFirst: false })
    .limit(30);
  if (error) {
    throw new Error(`handleListReminders failed: ${error.message}`);
  }
  const reminders = (data ?? []) as ReminderRow[];

  if (reminders.length === 0) {
    return "📋 No tienes recordatorios pendientes.";
  }

  const open: ReminderRow[] = [];
  const paused: ReminderRow[] = [];
  for (const r of reminders) {
    if (r.status === "paused") paused.push(r);
    else open.push(r);
  }

  const lines: string[] = [
    `📋 Tus recordatorios pendientes (${reminders.length}):`,
    "",
  ];
  if (open.length > 0) {
    lines.push("Activos / Programados:");
    for (const r of open) {
      lines.push(`• ${formatListEntry(r)}`);
    }
  }
  if (paused.length > 0) {
    if (open.length > 0) lines.push("");
    lines.push("Pausados:");
    for (const r of paused) {
      lines.push(`• ${formatListEntry(r, /*pausedRow*/ true)}`);
    }
  }

  safeLog("info", "reminder_op", {
    op: "list_reminders",
    count: reminders.length,
  });
  return lines.join("\n");
}

interface ReminderInsert {
  kind: ReminderKind;
  status: ReminderStatus;
  content?: string | null;
  raw_text?: string | null;
  recurrence_rule?: string | null;
  start_at?: string | null;
  next_trigger_at?: string | null;
  deadline_at?: string | null;
  timezone: string;
  condition?: ConditionPredicate | null;
  then_action?: ThenAction | null;
  re_evaluation_rule?: string | null;
  escalation_rule?: EscalationRule | null;
  stop_condition?: StopCondition | null;
  parent_reminder_id?: string | null;
  template_id?: TemplateId | null;
  template_params?: Record<string, unknown> | null;
  linked_task_id?: string | null;
  linked_list_item_id?: string | null;
}

async function insertReminderRow(
  insert: ReminderInsert,
): Promise<ReminderRow> {
  const { data, error } = await db
    .from("reminder")
    .insert(insert)
    .select()
    .single();
  if (error || !data) {
    throw new Error(
      `insertReminderRow failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data as ReminderRow;
}

async function resolveReminder(
  envelope: IntentEnvelope,
): Promise<ReminderRow> {
  const directId = envelope.entities.reminder_id?.trim();
  if (directId) {
    const { data, error } = await db
      .from("reminder")
      .select("*")
      .eq("id", directId)
      .maybeSingle();
    if (error) {
      throw new Error(`resolveReminder direct lookup failed: ${error.message}`);
    }
    if (!data) {
      throw new Error(`No encuentro el recordatorio con id ${directId}.`);
    }
    return data as ReminderRow;
  }

  const shortId = envelope.entities.short_id?.trim();
  if (shortId) {
    const { data, error } = await db
      .from("reminder")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      throw new Error(`resolveReminder short_id scan failed: ${error.message}`);
    }
    const lower = shortId.toLowerCase();
    const match = ((data ?? []) as ReminderRow[]).find((r) =>
      r.id.toLowerCase().startsWith(lower)
    );
    if (match) return match;
  }

  const content = envelope.entities.content?.trim();
  if (!content) {
    throw new Error(
      "No puedo identificar el recordatorio (falta reminder_id, short_id o content).",
    );
  }

  const { data, error } = await db
    .from("reminder")
    .select("*")
    .in("status", [...OPEN_STATUSES])
    .order("next_trigger_at", { ascending: true, nullsFirst: false })
    .limit(100);
  if (error) {
    throw new Error(`resolveReminder content scan failed: ${error.message}`);
  }

  const lower = content.toLowerCase();
  const candidates = (data ?? []) as ReminderRow[];
  const match =
    candidates.find((c) => (c.content ?? "").toLowerCase().includes(lower)) ??
      candidates.find((c) => lower.includes((c.content ?? "").toLowerCase()));
  if (!match) {
    throw new Error(
      `No encontré ningún recordatorio que coincida con «${content}».`,
    );
  }
  return match;
}

async function transitionReminder(
  reminderId: string,
  status: ReminderStatus,
  opts: { clearTrigger?: boolean } = {},
): Promise<void> {
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (opts.clearTrigger) {
    update.next_trigger_at = null;
  }
  const { error } = await db
    .from("reminder")
    .update(update)
    .eq("id", reminderId);
  if (error) {
    throw new Error(`transitionReminder failed: ${error.message}`);
  }
}

async function applyReminderUpdate(
  reminderId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("reminder")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", reminderId);
  if (error) {
    throw new Error(`applyReminderUpdate failed: ${error.message}`);
  }
}

async function cascadeChildStatus(
  parentId: string,
  status: ReminderStatus,
  opts: { clearTrigger?: boolean } = {},
): Promise<number> {
  const { data: childRows, error: selectErr } = await db
    .from("reminder")
    .select("id")
    .eq("parent_reminder_id", parentId);
  if (selectErr) {
    throw new Error(`cascadeChildStatus select failed: ${selectErr.message}`);
  }
  const childIds = ((childRows ?? []) as Array<{ id: string }>).map((r) =>
    r.id
  );
  if (childIds.length === 0) return 0;

  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (opts.clearTrigger) {
    update.next_trigger_at = null;
  }
  const { error: updateErr } = await db
    .from("reminder")
    .update(update)
    .in("id", childIds);
  if (updateErr) {
    throw new Error(`cascadeChildStatus update failed: ${updateErr.message}`);
  }
  return childIds.length;
}

function formatListEntry(r: ReminderRow, pausedRow = false): string {
  const id = shortId(r.id);
  const emoji = pausedRow ? "⏸" : kindEmoji(r.kind);
  const content = r.content ?? r.template_id ?? "(sin texto)";
  const when = r.next_trigger_at
    ? ` — ${formatDateInTz(new Date(r.next_trigger_at), r.timezone)}`
    : "";
  return `[${id}] ${emoji} «${content}»${when}`;
}

function describeReminder(r: ReminderRow): string {
  const label = r.content ?? r.template_id ?? "(sin texto)";
  return `«${label}»`;
}

function isValidTemplate(value: unknown): value is TemplateId {
  return typeof value === "string" &&
    (VALID_TEMPLATES as readonly string[]).includes(value);
}

function shortId(uuid: string): string {
  return uuid.substring(0, 8);
}

function kindEmoji(kind: ReminderKind): string {
  switch (kind) {
    case "static":
      return "⏰";
    case "recurring":
      return "🔁";
    case "dynamic":
      return "📊";
    case "conditional":
      return "🧪";
    case "escalation":
      return "⚠️";
    case "composite":
      return "🧩";
    default: {
      const exhaustive: never = kind;
      return String(exhaustive);
    }
  }
}

function formatDateInTz(date: Date, timezone: string): string {
  const components = formatInTimeZone(date, timezone, "yyyy-MM-dd HH:mm");
  const [datePart, timePart] = components.split(" ");
  const [yearStr, monthStr, dayStr] = datePart.split("-");
  const [hourStr, minuteStr] = timePart.split(":");

  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  const wallAsUtc = new Date(Date.UTC(year, month - 1, day));
  const weekday = WEEKDAYS_ES[wallAsUtc.getUTCDay()];
  const monthName = MONTHS_ES[month - 1];

  return `${weekday} ${day} de ${monthName} a las ${hourStr}:${minuteStr}`;
}

function parseIso(value: string, fieldName: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO 8601 value for ${fieldName}: ${value}`);
  }
  return date;
}

export async function handleAddPreNotifications(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const leadTimes = envelope.entities.lead_times_days ?? [];
  if (!Array.isArray(leadTimes) || leadTimes.length === 0) {
    return 'Dime con cuántos días de antelación quieres los avisos. Ej: "3, 21 y 1 días antes".';
  }

  const days = Array.from(
    new Set(
      leadTimes.filter((n): n is number => typeof n === "number" && n > 0).map(
        (n) => Math.floor(n),
      ),
    ),
  ).sort((a, b) => b - a);
  if (days.length === 0) {
    return "Los días de antelación deben ser números positivos.";
  }

  const target = await resolveTargetReminder(envelope);
  if (!target) {
    return "No encontré a qué recordatorio te refieres. Crea primero el recordatorio o dime su nombre.";
  }
  if (!target.next_trigger_at) {
    return `El recordatorio «${
      target.content ?? ""
    }» no tiene una fecha futura a la que adelantarse.`;
  }
  const parentTrigger = new Date(target.next_trigger_at);
  if (Number.isNaN(parentTrigger.getTime())) {
    return "La fecha del recordatorio destino no es válida.";
  }

  const created: number[] = [];
  const skipped: Array<{ days: number; reason: string }> = [];
  const nowMs = Date.now();
  const parentTitle = target.content ?? "(sin contenido)";

  for (const d of days) {
    const childTrigger = new Date(parentTrigger.getTime() - d * 86_400_000);
    if (childTrigger.getTime() <= nowMs) {
      skipped.push({ days: d, reason: "ya pasó" });
      continue;
    }
    const content = `Faltan ${d} ${
      d === 1 ? "día" : "días"
    } para «${parentTitle}»`;
    const { error } = await db.from("reminder").insert({
      kind: "static",
      status: "scheduled",
      content,
      next_trigger_at: childTrigger.toISOString(),
      parent_reminder_id: target.id,
      timezone: ownerTimezone,
    });
    if (error) {
      safeLog("warn", "add_pre_notification_failed", {
        parent_reminder_id: target.id,
        days: d,
        error: error.message,
      });
      skipped.push({ days: d, reason: "error" });
    } else {
      created.push(d);
      safeLog("info", "reminder_op", {
        op: "add_pre_notification",
        kind: "static",
        parent_reminder_id: target.id,
        days_before: d,
      });
    }
  }

  const lines: string[] = [];
  if (created.length > 0) {
    const list = created.map((d) => `${d}d`).join(", ");
    lines.push(`🔔 Pre-avisos añadidos a «${parentTitle}»: ${list} antes.`);
  } else {
    lines.push(`No pude añadir ningún pre-aviso a «${parentTitle}».`);
  }
  if (skipped.length > 0) {
    lines.push(
      `Saltados: ${skipped.map((s) => `${s.days}d (${s.reason})`).join(", ")}.`,
    );
  }
  return lines.join("\n");
}

async function resolveTargetReminder(
  envelope: IntentEnvelope,
): Promise<ReminderRow | null> {
  const e = envelope.entities;

  if (e.reminder_id) {
    const { data } = await db.from("reminder")
      .select("*")
      .eq("id", e.reminder_id)
      .maybeSingle();
    if (data) return data as ReminderRow;
  }

  if (e.short_id) {
    const { data } = await db.from("reminder")
      .select("*")
      .ilike("id", `${e.short_id}%`)
      .in("status", OPEN_STATUSES as unknown as string[])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data as ReminderRow;
  }

  if (e.content && e.content.trim().length >= 3) {
    const { data } = await db.from("reminder")
      .select("*")
      .ilike("content", `%${e.content.trim()}%`)
      .in("status", OPEN_STATUSES as unknown as string[])
      .order("next_trigger_at", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (data) return data as ReminderRow;
  }

  const { data } = await db.from("reminder")
    .select("*")
    .in("status", OPEN_STATUSES as unknown as string[])
    .not("next_trigger_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as ReminderRow | null) ?? null;
}
