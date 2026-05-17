import { db, safeLog } from "../supabase.ts";
import type { EventRow, IntentEnvelope } from "../types.ts";
import { formatInTimeZone } from "date-fns-tz";

export async function handleCalendarCreate(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const title = envelope.entities.content?.trim();
  const startIso = envelope.entities.trigger_at?.trim();
  if (!title) {
    throw new Error("calendar_create requires entities.content (title)");
  }
  if (!startIso) {
    throw new Error("calendar_create requires entities.trigger_at (starts_at)");
  }

  const startDate = parseIso(startIso, "trigger_at");
  const endIso = envelope.entities.deadline_at?.trim() ?? null;
  let endDate: Date | null = null;
  if (endIso) {
    endDate = parseIso(endIso, "deadline_at");
    if (endDate.getTime() <= startDate.getTime()) {
      throw new Error(
        "calendar_create: deadline_at must be strictly after trigger_at",
      );
    }
  }

  const tags = sanitizeStringArray(envelope.entities.tags);

  const { data, error } = await db
    .from("event")
    .insert({
      title,
      starts_at: startDate.toISOString(),
      ends_at: endDate ? endDate.toISOString() : null,
      tags,
    })
    .select()
    .single();
  if (error || !data) {
    throw new Error(
      `handleCalendarCreate insert failed: ${
        error?.message ?? "no row returned"
      }`,
    );
  }

  const event = data as EventRow;
  safeLog("info", "calendar_op", {
    op: "calendar_create",
    event_id: event.id,
  });
  const localized = formatInTimeZone(
    startDate,
    ownerTimezone,
    "yyyy-MM-dd HH:mm",
  );
  return `📅 Evento creado: «${event.title}» — ${localized}`;
}

export async function handleCalendarQuery(
  envelope: IntentEnvelope,
  ownerTimezone: string,
): Promise<string> {
  const hint = envelope.entities.content?.trim().toLowerCase() ?? "";
  const explicitDate = envelope.entities.trigger_at?.trim();
  const { from, to, label } = resolveRange(hint, explicitDate, ownerTimezone);

  const events = await getEventsInRange(from, to);
  safeLog("info", "calendar_op", {
    op: "calendar_query",
    event_count: events.length,
  });

  if (events.length === 0) {
    return "No tienes eventos en ese rango.";
  }

  const lines: string[] = [`📅 Eventos: ${label}`];
  for (const e of events) {
    const start = new Date(e.starts_at);
    const time = formatInTimeZone(start, ownerTimezone, "HH:mm");
    lines.push(`• ${time} — ${e.title}`);
  }
  return lines.join("\n");
}

export async function handleCalendarDelete(
  eventId: string,
): Promise<string> {
  const id = eventId.trim();
  if (!id) {
    throw new Error("handleCalendarDelete requires a non-empty id");
  }

  const event = await resolveEventById(id);

  const { error } = await db
    .from("event")
    .delete()
    .eq("id", event.id);
  if (error) {
    throw new Error(`handleCalendarDelete failed: ${error.message}`);
  }

  safeLog("info", "calendar_op", {
    op: "calendar_delete",
    event_id: event.id,
  });
  return `Evento eliminado: «${event.title}».`;
}

export async function getEventsInRange(
  from: Date,
  to: Date,
): Promise<EventRow[]> {
  const { data, error } = await db
    .from("event")
    .select("*")
    .gte("starts_at", from.toISOString())
    .lt("starts_at", to.toISOString())
    .order("starts_at", { ascending: true });
  if (error) {
    throw new Error(`getEventsInRange failed: ${error.message}`);
  }
  return (data ?? []) as EventRow[];
}

export async function isResourceBusy(
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const { data, error } = await db
    .from("event")
    .select("id, ends_at")
    .lt("starts_at", windowEnd.toISOString())
    .or(`ends_at.is.null,ends_at.gt.${windowStart.toISOString()}`)
    .limit(1);
  if (error) {
    throw new Error(`isResourceBusy failed: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

async function resolveEventById(id: string): Promise<EventRow> {
  const isFullUuid = /^[0-9a-f-]{36}$/i.test(id);
  if (isFullUuid) {
    const { data, error } = await db
      .from("event")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      throw new Error(
        `resolveEventById direct lookup failed: ${error.message}`,
      );
    }
    if (!data) {
      throw new Error(`No encuentro el evento con id ${id}.`);
    }
    return data as EventRow;
  }

  const { data, error } = await db
    .from("event")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    throw new Error(`resolveEventById scan failed: ${error.message}`);
  }
  const lower = id.toLowerCase();
  const match = ((data ?? []) as EventRow[]).find((e) =>
    e.id.toLowerCase().startsWith(lower)
  );
  if (!match) {
    throw new Error(
      `No encontré ningún evento con id que empiece por «${id}».`,
    );
  }
  return match;
}

function resolveRange(
  hint: string,
  explicitDate: string | undefined,
  tz: string,
): { from: Date; to: Date; label: string } {
  const normalized = stripAccents(hint);

  if (normalized.includes("manana")) {
    const start = startOfDayInTz(addDays(new Date(), 1), tz);
    return {
      from: start,
      to: addDays(start, 1),
      label: "mañana",
    };
  }
  if (normalized.includes("semana")) {
    const start = startOfDayInTz(new Date(), tz);
    return {
      from: start,
      to: addDays(start, 7),
      label: "esta semana",
    };
  }
  if (explicitDate) {
    const explicit = parseIso(explicitDate, "trigger_at");
    const start = startOfDayInTz(explicit, tz);
    return {
      from: start,
      to: addDays(start, 1),
      label: formatInTimeZone(start, tz, "yyyy-MM-dd"),
    };
  }

  const start = startOfDayInTz(new Date(), tz);
  return {
    from: start,
    to: addDays(start, 1),
    label: "hoy",
  };
}

function parseIso(value: string, fieldName: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO 8601 value for ${fieldName}: ${value}`);
  }
  return date;
}

function startOfDayInTz(date: Date, tz: string): Date {
  const ymd = formatInTimeZone(date, tz, "yyyy-MM-dd");
  const offset = formatInTimeZone(date, tz, "xxx");
  const iso = `${ymd}T00:00:00${offset === "Z" ? "+00:00" : offset}`;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`startOfDayInTz failed for ${date.toISOString()} / ${tz}`);
  }
  return start;
}

function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 86_400_000);
}

function sanitizeStringArray(input: string[] | undefined): string[] {
  if (!input) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const value = raw?.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stripAccents(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
