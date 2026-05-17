import { db, safeLog } from "../supabase.ts";
import type {
  IntentEnvelope,
  ListItemRow,
  ListItemStatus,
  ListRow,
} from "../types.ts";

export async function handleCreateList(
  envelope: IntentEnvelope,
): Promise<string> {
  const name = envelope.entities.list_name?.trim();
  if (!name) {
    throw new Error("create_list requires entities.list_name");
  }

  const list = await insertList(name);
  safeLog("info", "list_op", { op: "create_list", list_id: list.id });
  return `Lista «${list.name}» creada.`;
}

export async function handleAddToList(
  envelope: IntentEnvelope,
): Promise<string> {
  const listName = envelope.entities.list_name?.trim();
  const content = envelope.entities.content?.trim();
  if (!listName) {
    throw new Error("add_to_list requires entities.list_name");
  }
  if (!content) {
    throw new Error("add_to_list requires entities.content");
  }

  let list = await findListByName(listName);
  if (!list) {
    list = await insertList(listName);
    safeLog("info", "list_op", { op: "auto_create_list", list_id: list.id });
  }

  const nextPosition = await getNextPosition(list.id);

  const { data, error } = await db
    .from("list_item")
    .insert({
      list_id: list.id,
      content,
      position: nextPosition,
      status: "pending" satisfies ListItemStatus,
    })
    .select()
    .single();
  if (error || !data) {
    throw new Error(
      `handleAddToList insert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  const item = data as ListItemRow;
  safeLog("info", "list_op", {
    op: "add_to_list",
    list_id: list.id,
    item_id: item.id,
  });
  return `Añadido «${content}» a «${list.name}».`;
}

export async function handleCompleteListItem(
  envelope: IntentEnvelope,
): Promise<string> {
  const item = await resolveListItem(envelope, "pending");

  const { error } = await db
    .from("list_item")
    .update({
      status: "completed" satisfies ListItemStatus,
      completed_at: new Date().toISOString(),
    })
    .eq("id", item.id);
  if (error) {
    throw new Error(`handleCompleteListItem update failed: ${error.message}`);
  }

  safeLog("info", "list_op", {
    op: "complete_list_item",
    list_id: item.list_id,
    item_id: item.id,
  });
  return `Marcado como hecho: «${item.content}».`;
}

export async function handleRemoveListItem(
  envelope: IntentEnvelope,
): Promise<string> {
  const item = await resolveListItem(envelope);

  const { error } = await db
    .from("list_item")
    .delete()
    .eq("id", item.id);
  if (error) {
    throw new Error(`handleRemoveListItem delete failed: ${error.message}`);
  }

  safeLog("info", "list_op", {
    op: "remove_list_item",
    list_id: item.list_id,
    item_id: item.id,
  });
  return `Eliminado «${item.content}».`;
}

export async function handleQueryOffice(
  envelope: IntentEnvelope,
): Promise<string> {
  const listName = envelope.entities.list_name?.trim();

  if (listName) {
    const list = await findListByName(listName);
    if (!list) {
      return `No encuentro la lista «${listName}».`;
    }
    return await renderList(list);
  }

  const { data, error } = await db
    .from("list")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`handleQueryOffice list query failed: ${error.message}`);
  }
  const lists = (data ?? []) as ListRow[];
  if (lists.length === 0) {
    return "Aún no tienes listas.";
  }

  const lines: string[] = ["Tus listas:"];
  for (const list of lists) {
    const pending = await countPending(list.id);
    lines.push(`• «${list.name}» — ${pending} pendientes`);
  }
  safeLog("info", "list_op", {
    op: "query_office_index",
    list_count: lists.length,
  });
  return lines.join("\n");
}

export async function findListByName(name: string): Promise<ListRow | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  const { data: exact, error: exactErr } = await db
    .from("list")
    .select("*")
    .ilike("name", trimmed)
    .order("created_at", { ascending: false })
    .limit(1);
  if (exactErr) {
    throw new Error(`findListByName exact failed: ${exactErr.message}`);
  }
  const exactRow = (exact?.[0] as ListRow | undefined) ?? null;
  if (exactRow) {
    return exactRow;
  }

  const escaped = escapeLikePattern(trimmed);
  const { data: fuzzy, error: fuzzyErr } = await db
    .from("list")
    .select("*")
    .ilike("name", `%${escaped}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (fuzzyErr) {
    throw new Error(`findListByName fuzzy failed: ${fuzzyErr.message}`);
  }
  return (fuzzy?.[0] as ListRow | undefined) ?? null;
}

async function insertList(name: string): Promise<ListRow> {
  const { data, error } = await db
    .from("list")
    .insert({ name })
    .select()
    .single();
  if (error || !data) {
    throw new Error(
      `insertList failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data as ListRow;
}

async function getNextPosition(listId: string): Promise<number> {
  const { data, error } = await db
    .from("list_item")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`getNextPosition failed: ${error.message}`);
  }
  const current = (data as { position: number } | null)?.position ?? 0;
  return current + 1;
}

async function countPending(listId: string): Promise<number> {
  const { count, error } = await db
    .from("list_item")
    .select("id", { count: "exact", head: true })
    .eq("list_id", listId)
    .eq("status", "pending" satisfies ListItemStatus);
  if (error) {
    throw new Error(`countPending failed: ${error.message}`);
  }
  return count ?? 0;
}

async function renderList(list: ListRow): Promise<string> {
  const { data, error } = await db
    .from("list_item")
    .select("*")
    .eq("list_id", list.id)
    .order("position", { ascending: true });
  if (error) {
    throw new Error(`renderList query failed: ${error.message}`);
  }
  const items = (data ?? []) as ListItemRow[];
  const pending = items.filter((i) => i.status === "pending");
  const completed = items.filter((i) => i.status === "completed");

  const lines: string[] = [`Lista «${list.name}»:`];
  if (pending.length === 0 && completed.length === 0) {
    lines.push("  (vacía)");
  } else {
    for (const i of pending) {
      lines.push(`• ${i.content}`);
    }
    for (const i of completed) {
      lines.push(`• ✓ ${i.content}`);
    }
  }
  safeLog("info", "list_op", { op: "render_list", list_id: list.id });
  return lines.join("\n");
}

async function resolveListItem(
  envelope: IntentEnvelope,
  preferStatus?: ListItemStatus,
): Promise<ListItemRow> {
  const directId = envelope.entities.list_item_id?.trim();
  if (directId) {
    const { data, error } = await db
      .from("list_item")
      .select("*")
      .eq("id", directId)
      .maybeSingle();
    if (error) {
      throw new Error(`resolveListItem direct lookup failed: ${error.message}`);
    }
    if (!data) {
      throw new Error(`No encuentro el elemento con id ${directId}.`);
    }
    return data as ListItemRow;
  }

  const content = envelope.entities.content?.trim();
  if (!content) {
    throw new Error(
      "No puedo identificar el elemento (falta content o list_item_id).",
    );
  }

  let query = db
    .from("list_item")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (preferStatus) {
    query = query.eq("status", preferStatus);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`resolveListItem scan failed: ${error.message}`);
  }
  const candidates = (data ?? []) as ListItemRow[];

  const lower = content.toLowerCase();
  const match =
    candidates.find((c) => c.content.toLowerCase().includes(lower)) ??
      candidates.find((c) => lower.includes(c.content.toLowerCase()));
  if (!match) {
    throw new Error(`No encontré ningún elemento que contenga «${content}».`);
  }
  return match;
}

function escapeLikePattern(input: string): string {
  return input.replace(/([\\%_])/g, "\\$1");
}
