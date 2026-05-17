import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { OwnerRow } from "./types.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
  );
}

export const db: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-application-name": "memorae-personal" },
    },
  },
);

export async function getOwner(): Promise<OwnerRow | null> {
  const { data, error } = await db
    .from("owner")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw new Error(`getOwner failed: ${error.message}`);
  }
  return (data as OwnerRow | null) ?? null;
}

export async function ensureOwner(
  chatId: number,
  displayName?: string,
  timezone: string = "UTC",
  language: string = "en",
): Promise<OwnerRow> {
  const { data: existing } = await db
    .from("owner")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (existing) {
    const row = existing as OwnerRow;
    const updates: Record<string, unknown> = {};
    if (row.chat_id !== chatId) updates.chat_id = chatId;
    if (displayName && row.display_name !== displayName) {
      updates.display_name = displayName;
    }
    if (Object.keys(updates).length > 0) {
      const { error: updErr } = await db.from("owner").update(updates).eq(
        "id",
        1,
      );
      if (updErr) {
        throw new Error(`ensureOwner update failed: ${updErr.message}`);
      }
      return { ...row, ...updates } as OwnerRow;
    }
    return row;
  }

  const { error: insertError } = await db
    .from("owner")
    .insert({
      id: 1,
      chat_id: chatId,
      display_name: displayName,
      timezone,
      language,
    });
  if (insertError) {
    throw new Error(`ensureOwner insert failed: ${insertError.message}`);
  }

  const { data, error: selectError } = await db
    .from("owner")
    .select("*")
    .eq("id", 1)
    .single();

  if (selectError || !data) {
    throw new Error(
      `ensureOwner select failed: ${selectError?.message ?? "no row returned"}`,
    );
  }

  return data as OwnerRow;
}

export async function logAudit(
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await db
      .from("audit_log")
      .insert({ event_type: eventType, payload });
    if (error) {
      console.error("logAudit insert error", {
        eventType,
        error: error.message,
      });
    }
  } catch (err: unknown) {
    console.error("logAudit threw", {
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function safeLog(
  level: "info" | "warn" | "error",
  event: string,
  payload: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...payload,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
