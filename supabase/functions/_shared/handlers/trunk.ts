import { db, safeLog } from "../supabase.ts";
import { downloadFile, getFile, sendDocument } from "../telegram.ts";
import type { IntentEnvelope, TrunkObjectRow } from "../types.ts";

export interface TelegramFileRef {
  file_id: string;
}

export interface TelegramMessageWithFile {
  document?: TelegramFileRef & {
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  photo?: Array<TelegramFileRef & { file_size?: number }>;
  audio?: TelegramFileRef & {
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: TelegramFileRef & {
    mime_type?: string;
    file_size?: number;
  };
  caption?: string;
}

export const MAX_TOTAL_BYTES = 800 * 1024 * 1024;

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const TRUNK_LIST_PAGE_SIZE = 50;

const BUCKET = "trunk";

export async function handleStoreFile(
  message: TelegramMessageWithFile,
  // deno-lint-ignore no-unused-vars
  chatId: number,
): Promise<string> {
  const ref = pickFileRef(message);
  if (!ref) {
    throw new Error("handleStoreFile: el mensaje no contiene archivo.");
  }

  const tgFile = await getFile(ref.fileId);
  const filePath = tgFile.file_path;
  const fileSize = tgFile.file_size ?? ref.fileSize;
  if (!filePath || typeof fileSize !== "number") {
    throw new Error("Telegram no devolvió ruta del archivo.");
  }

  if (fileSize > MAX_FILE_BYTES) {
    throw new Error(
      `El archivo supera el límite de ${
        formatBytes(MAX_FILE_BYTES)
      } por archivo.`,
    );
  }

  const total = await getTrunkUsageBytes();
  if (total + fileSize > MAX_TOTAL_BYTES) {
    throw new Error(
      `Tu Memory_Trunk superaría el límite total de ${
        formatBytes(MAX_TOTAL_BYTES)
      } (uso actual: ${formatBytes(total)}).`,
    );
  }

  const bytes = await downloadFile(filePath);
  const sha256 = await sha256Hex(bytes);

  const id = crypto.randomUUID();
  const originalName = ref.originalName;
  const mimeType = ref.mimeType;
  const storagePath = `${id}/${slug(originalName)}`;

  const { error: uploadError } = await db.storage
    .from(BUCKET)
    .upload(storagePath, bytes, {
      contentType: mimeType,
      cacheControl: "private, max-age=0",
      upsert: false,
    });
  if (uploadError) {
    throw new Error(
      `handleStoreFile upload failed: ${uploadError.message}`,
    );
  }

  const { data, error: insertError } = await db
    .from("trunk_object")
    .insert({
      id,
      original_name: originalName,
      mime_type: mimeType,
      size_bytes: fileSize,
      sha256,
      tags: [],
      storage_path: storagePath,
    })
    .select("id")
    .single();
  if (insertError || !data) {
    const { error: cleanupError } = await db.storage
      .from(BUCKET)
      .remove([storagePath]);
    if (cleanupError) {
      safeLog("warn", "trunk_op", {
        op: "upload_orphan",
        size_bytes: fileSize,
      });
    }
    throw new Error(
      `handleStoreFile insert failed: ${
        insertError?.message ?? "no row returned"
      }`,
    );
  }

  const inserted = data as Pick<TrunkObjectRow, "id">;
  safeLog("info", "trunk_op", {
    op: "upload",
    object_id: inserted.id,
    size_bytes: fileSize,
  });

  return `📦 Archivo guardado en Memory_Trunk: «${originalName}» (${
    formatBytes(fileSize)
  }).`;
}

export async function handleRetrieveFile(
  envelope: IntentEnvelope,
  chatId: number,
): Promise<string> {
  const rawQuery = envelope.entities.content?.trim() ?? "";
  const tags = normalizeTags(envelope.entities.tags);

  if (!rawQuery && tags.length === 0) {
    throw new Error(
      "retrieve_file: faltan parámetros de búsqueda (nombre o etiqueta).",
    );
  }

  const row = await findTrunkObject(rawQuery, tags);
  if (!row) {
    return `No encontré ningún archivo con «${rawQuery || tags.join(", ")}».`;
  }

  const { data: blob, error: downloadError } = await db.storage
    .from(BUCKET)
    .download(row.storage_path);
  if (downloadError || !blob) {
    throw new Error(
      `handleRetrieveFile download failed: ${
        downloadError?.message ?? "no bytes returned"
      }`,
    );
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  await sendDocument(chatId, row.original_name, bytes, row.mime_type);

  safeLog("info", "trunk_op", {
    op: "retrieve",
    object_id: row.id,
    size_bytes: row.size_bytes,
  });

  return `Te envié «${row.original_name}».`;
}

export async function handleListTrunk(page: number = 1): Promise<string> {
  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * TRUNK_LIST_PAGE_SIZE;

  const { data, error } = await db
    .from("trunk_object")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + TRUNK_LIST_PAGE_SIZE - 1);
  if (error) {
    throw new Error(`handleListTrunk query failed: ${error.message}`);
  }

  const rows = (data ?? []) as TrunkObjectRow[];
  if (rows.length === 0) {
    return safePage === 1
      ? "Tu Memory_Trunk está vacío."
      : `No hay archivos en la página ${safePage}.`;
  }

  const lines: string[] = [`Memory_Trunk (página ${safePage}):`];
  rows.forEach((r, idx) => {
    const n = offset + idx + 1;
    lines.push(
      `${n}. ${r.original_name} — ${formatBytes(r.size_bytes)} — ${
        formatRelativeDate(r.created_at)
      }`,
    );
  });

  safeLog("info", "trunk_op", {
    op: "list",
    page: safePage,
    returned: rows.length,
  });
  return lines.join("\n");
}

export async function handleDeleteTrunkObject(
  objectId: string,
): Promise<string> {
  const { data, error: lookupError } = await db
    .from("trunk_object")
    .select("*")
    .eq("id", objectId)
    .maybeSingle();
  if (lookupError) {
    throw new Error(
      `handleDeleteTrunkObject lookup failed: ${lookupError.message}`,
    );
  }
  if (!data) {
    throw new Error(`No encuentro el archivo con id ${objectId}.`);
  }
  const row = data as TrunkObjectRow;

  const { error: storageError } = await db.storage
    .from(BUCKET)
    .remove([row.storage_path]);
  if (storageError) {
    safeLog("error", "trunk_op", {
      op: "delete_storage_failed",
      object_id: row.id,
    });
    throw new Error(
      `handleDeleteTrunkObject storage remove failed: ${storageError.message}`,
    );
  }

  const { error: rowError } = await db
    .from("trunk_object")
    .delete()
    .eq("id", row.id);
  if (rowError) {
    safeLog("warn", "trunk_op", {
      op: "delete_row_orphan",
      object_id: row.id,
    });
  }

  safeLog("info", "trunk_op", {
    op: "delete",
    object_id: row.id,
    size_bytes: row.size_bytes,
  });
  return `Eliminado «${row.original_name}».`;
}

export async function getTrunkUsageBytes(): Promise<number> {
  const { data, error } = await db
    .from("trunk_object")
    .select("size_bytes");
  if (error) {
    throw new Error(`getTrunkUsageBytes failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{ size_bytes: number }>;
  let total = 0;
  for (const r of rows) {
    total += Number(r.size_bytes) || 0;
  }
  return total;
}

interface FileRef {
  fileId: string;
  originalName: string;
  mimeType: string;
  fileSize?: number;
}

function pickFileRef(message: TelegramMessageWithFile): FileRef | null {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      originalName: message.document.file_name ?? `document-${Date.now()}.bin`,
      mimeType: message.document.mime_type ?? "application/octet-stream",
      fileSize: message.document.file_size,
    };
  }
  if (message.photo && message.photo.length > 0) {
    const best = message.photo[message.photo.length - 1];
    return {
      fileId: best.file_id,
      originalName: `photo-${Date.now()}.jpg`,
      mimeType: "image/jpeg",
      fileSize: best.file_size,
    };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      originalName: message.audio.file_name ?? `audio-${Date.now()}.mp3`,
      mimeType: message.audio.mime_type ?? "audio/mpeg",
      fileSize: message.audio.file_size,
    };
  }
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      originalName: `voice-${Date.now()}.ogg`,
      mimeType: message.voice.mime_type ?? "audio/ogg",
      fileSize: message.voice.file_size,
    };
  }
  return null;
}

async function findTrunkObject(
  query: string,
  tags: string[],
): Promise<TrunkObjectRow | null> {
  if (query) {
    let exact = db
      .from("trunk_object")
      .select("*")
      .ilike("original_name", query)
      .order("created_at", { ascending: false })
      .limit(1);
    if (tags.length > 0) {
      exact = exact.overlaps("tags", tags);
    }
    const { data, error } = await exact;
    if (error) {
      throw new Error(`findTrunkObject exact failed: ${error.message}`);
    }
    const row = (data?.[0] as TrunkObjectRow | undefined) ?? null;
    if (row) return row;
  }

  if (query) {
    const escaped = escapeLikePattern(query);
    let fuzzy = db
      .from("trunk_object")
      .select("*")
      .ilike("original_name", `%${escaped}%`)
      .order("created_at", { ascending: false })
      .limit(1);
    if (tags.length > 0) {
      fuzzy = fuzzy.overlaps("tags", tags);
    }
    const { data, error } = await fuzzy;
    if (error) {
      throw new Error(`findTrunkObject fuzzy failed: ${error.message}`);
    }
    const row = (data?.[0] as TrunkObjectRow | undefined) ?? null;
    if (row) return row;
  }

  if (tags.length > 0) {
    const { data, error } = await db
      .from("trunk_object")
      .select("*")
      .overlaps("tags", tags)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      throw new Error(`findTrunkObject tags failed: ${error.message}`);
    }
    return (data?.[0] as TrunkObjectRow | undefined) ?? null;
  }

  return null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9.\-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return cleaned || "file";
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
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

function escapeLikePattern(input: string): string {
  return input.replace(/([\\%_])/g, "\\$1");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaMs = Date.now() - then;
  if (deltaMs < 60_000) return "hace unos segundos";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return minutes === 1 ? "hace 1 minuto" : `hace ${minutes} minutos`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "hace 1 hora" : `hace ${hours} horas`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return days === 1 ? "hace 1 día" : `hace ${days} días`;
  }
  const months = Math.floor(days / 30);
  return months === 1 ? "hace 1 mes" : `hace ${months} meses`;
}
