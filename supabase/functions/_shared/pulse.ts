import { db } from "./supabase.ts";

export interface NudgeCandidate {
  kind: string;
  payload: Record<string, unknown>;
  reason: string;
  ready_at?: Date;
}

export async function detectCollisions(): Promise<NudgeCandidate[]> {
  const { data: ownerRow } = await db.from("owner")
    .select("timezone").eq("id", 1).maybeSingle();
  const tz = (ownerRow as { timezone?: string } | null)?.timezone ?? "UTC";

  const { data } = await db.from("upcoming_collisions").select("day, items");
  const rows = (data ?? []) as Array<
    {
      day: string;
      items: Array<
        { id: string; title: string; at: string; source: string }
      >;
    }
  >;
  const todayKey = formatYmdInZone(new Date(), tz);
  const out: NudgeCandidate[] = [];
  for (const r of rows) {
    const dayKey = r.day.slice(0, 10);
    const diffDays = daysBetweenYmd(todayKey, dayKey);
    if (diffDays < 0 || diffDays > 30) continue;
    if (r.items.length < 2) continue;
    out.push({
      kind: "collision",
      payload: { day: dayKey, items: r.items, days_ahead: diffDays },
      reason:
        `${r.items.length} cosas el mismo dia (${dayKey}): ${
          r.items.map((i) => i.title).join(", ")
        }.`,
    });
  }
  return out;
}

function formatYmdInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

export async function detectBirthdayWindows(): Promise<NudgeCandidate[]> {
  const { data } = await db.from("upcoming_birthdays")
    .select("id, name, birthday, next_birthday");
  const rows = (data ?? []) as Array<
    { id: string; name: string; birthday: string; next_birthday: string }
  >;
  const out: NudgeCandidate[] = [];
  const now = Date.now();
  for (const r of rows) {
    const next = new Date(r.next_birthday).getTime();
    const days = Math.round((next - now) / 86_400_000);
    if (days === 30 || days === 14 || days === 7 || days === 1) {
      out.push({
        kind: "birthday_window",
        payload: { friend_id: r.id, name: r.name, days, date: r.next_birthday },
        reason: days === 1
          ? `Manana cumple ${r.name}.`
          : `${days} dias para el cumple de ${r.name}.`,
      });
    }
  }
  return out;
}

export async function detectStaleHabits(): Promise<NudgeCandidate[]> {
  const { data } = await db.from("habit").select(
    "id, title, cadence_days, last_done_at, streak_count, active",
  ).eq("active", true);
  const rows = (data ?? []) as Array<
    {
      id: string;
      title: string;
      cadence_days: number;
      last_done_at: string | null;
      streak_count: number;
      active: boolean;
    }
  >;
  const out: NudgeCandidate[] = [];
  const now = Date.now();
  for (const h of rows) {
    if (!h.last_done_at) continue;
    const last = new Date(h.last_done_at).getTime();
    const overdueDays = Math.floor(
      (now - last) / 86_400_000 - h.cadence_days,
    );
    if (overdueDays >= 1 && overdueDays <= 14) {
      out.push({
        kind: "stale_habit",
        payload: {
          habit_id: h.id,
          title: h.title,
          overdue_days: overdueDays,
          streak_lost: h.streak_count >= 3,
        },
        reason: h.streak_count >= 3
          ? `Llevabas ${h.streak_count} dias seguidos con "${h.title}" y hace ${overdueDays} dia${
            overdueDays === 1 ? "" : "s"
          } que no lo marcas.`
          : `Hace ${overdueDays} dia${
            overdueDays === 1 ? "" : "s"
          } que no haces "${h.title}".`,
      });
    }
  }
  return out;
}

export async function detectIdlePeriod(
  thresholdDays: number = 5,
): Promise<NudgeCandidate[]> {
  const { data } = await db.from("inbound_message")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { created_at: string } | null;
  if (!row) return [];
  const last = new Date(row.created_at).getTime();
  const days = Math.floor((Date.now() - last) / 86_400_000);
  if (days < thresholdDays) return [];
  return [{
    kind: "idle",
    payload: { days_since_last: days },
    reason: `Hace ${days} dias que no me escribes.`,
  }];
}

function dedupKey(kind: string, payload: Record<string, unknown>): string {
  if (kind === "collision") return `collision:${String(payload.day ?? "")}`;
  if (kind === "birthday_window") {
    return `birthday:${String(payload.friend_id ?? "")}:${
      String(payload.days ?? "")
    }`;
  }
  if (kind === "stale_habit") {
    return `stale:${String(payload.habit_id ?? "")}`;
  }
  if (kind === "idle") {
    const d = Number(payload.days_since_last) || 0;
    const bucket = Math.floor(d / 5);
    return `idle:${bucket}`;
  }
  return `${kind}:${JSON.stringify(payload)}`;
}

export async function enqueueNudges(
  candidates: NudgeCandidate[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  const { data: existing } = await db.from("proactive_nudge")
    .select("kind, payload")
    .is("delivered_at", null)
    .is("dismissed_at", null)
    .gt("expires_at", new Date().toISOString());
  const existingKeys = new Set(
    (existing ?? []).map((r) =>
      dedupKey(
        (r as { kind: string }).kind,
        (r as { payload: Record<string, unknown> }).payload ?? {},
      )
    ),
  );
  const fresh = candidates.filter((c) =>
    !existingKeys.has(dedupKey(c.kind, c.payload))
  );
  if (fresh.length === 0) return 0;
  const rows = fresh.map((c) => ({
    kind: c.kind,
    payload: c.payload,
    reason: c.reason,
    ready_at: (c.ready_at ?? new Date()).toISOString(),
  }));
  const { error } = await db.from("proactive_nudge").insert(rows);
  if (error) throw new Error(`enqueueNudges: ${error.message}`);
  return fresh.length;
}

export async function pickNextNudge(): Promise<
  | {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    reason: string;
  }
  | null
> {
  const now = new Date().toISOString();
  const { data } = await db.from("proactive_nudge")
    .select("id, kind, payload, reason, ready_at")
    .is("delivered_at", null)
    .is("dismissed_at", null)
    .lte("ready_at", now)
    .gt("expires_at", now)
    .order("ready_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data as
    | {
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      reason: string;
    }
    | null;
}

export async function markNudgeDelivered(id: string): Promise<void> {
  await db.from("proactive_nudge").update({
    delivered_at: new Date().toISOString(),
  }).eq("id", id);
}

export async function dismissNudge(id: string): Promise<void> {
  await db.from("proactive_nudge").update({
    dismissed_at: new Date().toISOString(),
  }).eq("id", id);
}
