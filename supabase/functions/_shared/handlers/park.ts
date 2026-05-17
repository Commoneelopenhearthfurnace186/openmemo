import { db, safeLog } from "../supabase.ts";
import { DeepSeekError, embed } from "../deepseek.ts";
import type { IntentEnvelope, MemoryBubbleRow } from "../types.ts";

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.toLowerCase().trim().replace(/\s+/g, " ");
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

interface SearchParkRow {
  id: string;
  content: string;
  score: number;
}

const SIMILARITY_THRESHOLD = 0.3;

const MAX_DISPLAYED_RESULTS = 5;

export async function handleCreateMemoryBubble(
  envelope: IntentEnvelope,
): Promise<string> {
  const rawContent = envelope.entities.content;
  if (typeof rawContent !== "string" || rawContent.trim() === "") {
    throw new Error("create_memory_bubble: missing entities.content");
  }
  const content = rawContent.trim();
  const tags = normalizeTags(envelope.entities.tags ?? []);
  const language = envelope.language ?? "es";

  const embedding = await embed(content);

  const { data, error } = await db
    .from("memory_bubble")
    .insert({ content, tags, language, embedding })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(
      `create_memory_bubble insert failed: ${
        error?.message ?? "no row returned"
      }`,
    );
  }

  const inserted = data as Pick<MemoryBubbleRow, "id">;
  safeLog("info", "park_op", { op: "create", bubble_id: inserted.id });
  return "📝 Nota guardada en The Park.";
}

export async function handleUpdateMemoryBubble(
  bubbleId: string,
  newContent: string,
  newTags?: string[],
): Promise<string> {
  if (typeof newContent !== "string" || newContent.trim() === "") {
    throw new Error("update_memory_bubble: missing newContent");
  }
  const content = newContent.trim();

  const { data: existing, error: lookupError } = await db
    .from("memory_bubble")
    .select("id, content")
    .eq("id", bubbleId)
    .is("deleted_at", null)
    .maybeSingle();

  if (lookupError) {
    throw new Error(
      `update_memory_bubble lookup failed: ${lookupError.message}`,
    );
  }
  if (!existing) {
    throw new Error(`update_memory_bubble: bubble ${bubbleId} not found`);
  }

  const previous = existing as Pick<MemoryBubbleRow, "id" | "content">;
  const update: Record<string, unknown> = {
    content,
    updated_at: new Date().toISOString(),
  };
  if (newTags !== undefined) {
    update.tags = normalizeTags(newTags);
  }
  if (previous.content !== content) {
    update.embedding = await embed(content);
  }

  const { error: updateError } = await db
    .from("memory_bubble")
    .update(update)
    .eq("id", bubbleId);

  if (updateError) {
    throw new Error(
      `update_memory_bubble update failed: ${updateError.message}`,
    );
  }

  safeLog("info", "park_op", { op: "update", bubble_id: bubbleId });
  return "Nota actualizada.";
}

export async function handleDeleteMemoryBubble(
  bubbleId: string,
): Promise<string> {
  const { error } = await db
    .from("memory_bubble")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", bubbleId)
    .is("deleted_at", null);

  if (error) {
    throw new Error(`delete_memory_bubble failed: ${error.message}`);
  }

  safeLog("info", "park_op", { op: "delete", bubble_id: bubbleId });
  return "Nota eliminada (recuperable durante 30 días).";
}

export async function handleQueryPark(
  envelope: IntentEnvelope,
): Promise<string> {
  const rawQuery = envelope.entities.content;
  if (typeof rawQuery !== "string" || rawQuery.trim() === "") {
    throw new Error("query_park: missing entities.content");
  }
  const query = rawQuery.trim();
  const tags = normalizeTags(envelope.entities.tags ?? []);

  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch (err: unknown) {
    if (err instanceof DeepSeekError) {
      safeLog("warn", "park_op", {
        op: "query_embed_failed",
        status_code: err.statusCode,
      });
      throw new Error(
        "No pude calcular el embedding de tu búsqueda; reintenta en unos minutos.",
      );
    }
    throw err;
  }

  const { data, error } = await db.rpc("search_park", {
    query_embedding: queryVec,
    tag_filter: tags.length > 0 ? tags : null,
    k: 20,
  });

  if (error) {
    throw new Error(`query_park rpc failed: ${error.message}`);
  }

  const rows = (data ?? []) as SearchParkRow[];
  const matches = rows.filter((r) => r.score > SIMILARITY_THRESHOLD);

  safeLog("info", "park_op", {
    op: "query",
    returned: rows.length,
    matches: matches.length,
  });

  if (matches.length === 0) {
    return "No encontré nada parecido en The Park.";
  }

  const top = matches.slice(0, MAX_DISPLAYED_RESULTS);
  const noun = matches.length === 1 ? "nota" : "notas";
  const header = `🔎 Encontré ${matches.length} ${noun}:`;
  const lines = top.map((r) => {
    const pct = Math.round(r.score * 100);
    return `• ${r.content} (similitud ${pct}%)`;
  });
  return [header, ...lines].join("\n");
}
