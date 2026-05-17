import { type Options, RRule } from "rrule";
import { formatInTimeZone } from "date-fns-tz";
import type { EscalationRule, ReminderRow } from "./types.ts";

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

function formatSpanish(date: Date, timezone: string): string {
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

export function parseRRule(
  rrule: string,
  dtstart: Date,
  timezone: string,
): RRule {
  if (typeof rrule !== "string" || rrule.trim().length === 0) {
    throw new Error("parseRRule: empty RRULE string");
  }
  if (!(dtstart instanceof Date) || Number.isNaN(dtstart.getTime())) {
    throw new Error("parseRRule: invalid dtstart");
  }
  if (typeof timezone !== "string" || timezone.length === 0) {
    throw new Error("parseRRule: empty timezone");
  }

  let parsed: Partial<Options>;
  try {
    parsed = RRule.parseString(rrule) as Partial<Options>;
  } catch (err) {
    throw new Error(
      `parseRRule: failed to parse "${rrule}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!parsed.freq && parsed.freq !== 0) {
    throw new Error(`parseRRule: RRULE missing FREQ: "${rrule}"`);
  }

  const options: Partial<Options> = {
    ...parsed,
    dtstart,
    tzid: timezone,
  };

  try {
    return new RRule(options as Options);
  } catch (err) {
    throw new Error(
      `parseRRule: failed to construct RRule for "${rrule}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

type ComputeInput = Pick<
  ReminderRow,
  | "kind"
  | "next_trigger_at"
  | "recurrence_rule"
  | "re_evaluation_rule"
  | "escalation_rule"
  | "attempt_count"
  | "timezone"
  | "start_at"
>;

function anchorFor(reminder: ComputeInput, after: Date): Date {
  if (reminder.start_at) {
    const d = new Date(reminder.start_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (reminder.next_trigger_at) {
    const d = new Date(reminder.next_trigger_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return after;
}

export function computeNextTrigger(
  reminder: ComputeInput,
  after: Date,
): Date | null {
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) {
    throw new Error("computeNextTrigger: invalid `after` instant");
  }

  switch (reminder.kind) {
    case "static": {
      if (!reminder.next_trigger_at) return null;
      const at = new Date(reminder.next_trigger_at);
      if (Number.isNaN(at.getTime())) return null;
      return at > after ? at : null;
    }

    case "recurring":
    case "dynamic": {
      if (!reminder.recurrence_rule) {
        throw new Error(
          `computeNextTrigger: kind="${reminder.kind}" requires recurrence_rule`,
        );
      }
      const rule = parseRRule(
        reminder.recurrence_rule,
        anchorFor(reminder, after),
        reminder.timezone,
      );
      return rule.after(after, true);
    }

    case "conditional": {
      if (reminder.re_evaluation_rule) {
        const rule = parseRRule(
          reminder.re_evaluation_rule,
          anchorFor(reminder, after),
          reminder.timezone,
        );
        return rule.after(after, true);
      }
      if (!reminder.next_trigger_at) return null;
      const at = new Date(reminder.next_trigger_at);
      if (Number.isNaN(at.getTime())) return null;
      return at > after ? at : null;
    }

    case "escalation": {
      if (!reminder.escalation_rule) {
        throw new Error(
          'computeNextTrigger: kind="escalation" requires escalation_rule',
        );
      }
      return computeEscalationNext(
        reminder.escalation_rule,
        after,
        reminder.attempt_count,
        reminder.timezone,
      );
    }

    case "composite":
      return null;

    default: {
      const exhaustive: never = reminder.kind;
      throw new Error(
        `computeNextTrigger: unsupported reminder kind: ${String(exhaustive)}`,
      );
    }
  }
}

export function computeEscalationNext(
  rule: EscalationRule,
  after: Date,
  attemptCount: number,
  timezone: string,
): Date | null {
  if (!rule || typeof rule !== "object") {
    throw new Error("computeEscalationNext: missing escalation rule");
  }
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) {
    throw new Error("computeEscalationNext: invalid `after` instant");
  }
  if (typeof attemptCount !== "number" || attemptCount < 0) {
    throw new Error("computeEscalationNext: invalid attemptCount");
  }

  if (attemptCount >= 50) return null;

  if (
    typeof rule.max_attempts === "number" &&
    attemptCount >= rule.max_attempts
  ) {
    return null;
  }

  switch (rule.policy) {
    case "repeat_after_delay": {
      if (
        typeof rule.interval_minutes !== "number" ||
        rule.interval_minutes <= 0
      ) {
        throw new Error(
          'computeEscalationNext: policy="repeat_after_delay" requires positive interval_minutes',
        );
      }
      return new Date(after.getTime() + rule.interval_minutes * 60_000);
    }

    case "recur_until_completed": {
      if (!rule.recurrence_rule) {
        throw new Error(
          'computeEscalationNext: policy="recur_until_completed" requires recurrence_rule',
        );
      }
      const parsed = parseRRule(rule.recurrence_rule, after, timezone);
      return parsed.after(after, true);
    }

    default: {
      const exhaustive: never = rule.policy;
      throw new Error(
        `computeEscalationNext: unsupported policy: ${String(exhaustive)}`,
      );
    }
  }
}

export function previewOccurrences(
  rrule: string,
  start: Date,
  timezone: string,
  n: number = 5,
): string[] {
  if (typeof n !== "number" || n <= 0 || !Number.isFinite(n)) {
    throw new Error("previewOccurrences: `n` must be a positive integer");
  }

  const rule = parseRRule(rrule, start, timezone);
  const limit = Math.floor(n);
  const occurrences: Date[] = rule.all((_d: Date, i: number): boolean => {
    return i < limit;
  });

  return occurrences.map((d) => formatSpanish(d, timezone));
}

const RRULE_WEEKDAYS_ES: readonly string[] = [
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
];

const SETPOS_ORDINALS_ES: Readonly<Record<number, string>> = {
  1: "primer",
  2: "segundo",
  3: "tercer",
  4: "cuarto",
  [-1]: "último",
};

function toArray<T>(v: T | readonly T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? [...v] : [v as T];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function weekdayNumber(w: unknown): number | null {
  if (typeof w === "number") return w;
  if (
    w && typeof w === "object" && "weekday" in (w as Record<string, unknown>)
  ) {
    const n = (w as { weekday: unknown }).weekday;
    if (typeof n === "number") return n;
  }
  return null;
}

function describeRRule(opts: Partial<Options>, raw: string): string {
  const freq = opts.freq;
  const interval = opts.interval ?? 1;
  const byweekday = toArray(opts.byweekday)
    .map(weekdayNumber)
    .filter((n): n is number => n !== null);
  const bymonthday = toArray(opts.bymonthday);
  const byhour = toArray(opts.byhour);
  const byminute = toArray(opts.byminute);
  const bysetpos = toArray(opts.bysetpos);

  const timeOfDay = byhour.length === 1 && byminute.length === 1
    ? `${pad2(byhour[0])}:${pad2(byminute[0])}`
    : null;
  const atSuffix = timeOfDay ? ` a las ${timeOfDay}` : "";

  if (freq === RRule.HOURLY) {
    return interval === 1 ? "Cada hora" : `Cada ${interval} horas`;
  }

  if (freq === RRule.DAILY) {
    if (interval === 1) return `Cada día${atSuffix}`;
    return `Cada ${interval} días${atSuffix}`;
  }

  if (freq === RRule.WEEKLY) {
    if (interval === 1 && byweekday.length === 1) {
      return `Cada ${RRULE_WEEKDAYS_ES[byweekday[0]]}${atSuffix}`;
    }
    if (interval === 1 && byweekday.length > 1) {
      const dias = byweekday.map((w) => RRULE_WEEKDAYS_ES[w]).join(", ");
      return `Cada semana los ${dias}${atSuffix}`;
    }
  }

  if (freq === RRule.MONTHLY) {
    const businessWeekdays = [0, 1, 2, 3, 4];
    const isBusinessWeekdays = byweekday.length === 5 &&
      businessWeekdays.every((w) => byweekday.includes(w));
    if (isBusinessWeekdays && bysetpos.length === 1 && bysetpos[0] === -1) {
      return `El último día hábil de cada mes${atSuffix}`;
    }

    if (
      byweekday.length === 1 &&
      bysetpos.length === 1 &&
      SETPOS_ORDINALS_ES[bysetpos[0]] !== undefined
    ) {
      const ord = SETPOS_ORDINALS_ES[bysetpos[0]];
      const dia = RRULE_WEEKDAYS_ES[byweekday[0]];
      return `El ${ord} ${dia} de cada mes${atSuffix}`;
    }

    if (bymonthday.length === 1) {
      return `El día ${bymonthday[0]} de cada mes${atSuffix}`;
    }
  }

  return raw;
}

export function summarizeRRule(
  rrule: string,
  start: Date,
  timezone: string,
): { description: string; nextOccurrences: string[] } {
  const rule = parseRRule(rrule, start, timezone);
  const description = describeRRule(rule.origOptions, rrule);
  const nextOccurrences = previewOccurrences(rrule, start, timezone, 5);
  return { description, nextOccurrences };
}
