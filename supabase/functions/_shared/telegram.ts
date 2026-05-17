import { safeLog } from "./supabase.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Missing required env var: TELEGRAM_BOT_TOKEN");
}

const API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/`;
const FILE_BASE = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/`;

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [250, 500] as const;

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramSendMessageOptions {
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
  reply_to_message_id?: number;
  reply_markup?: unknown;
}

export type ChatAction =
  | "typing"
  | "upload_photo"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "find_location"
  | "record_video"
  | "upload_video";

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly statusCode: number,
    public readonly description: string,
  ) {
    super(`Telegram ${method} failed (${statusCode}): ${description}`);
    this.name = "TelegramApiError";
  }
}

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

function constantTimeEquals(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? (a.codePointAt(i) ?? 0) : 0;
    const cb = i < b.length ? (b.codePointAt(i) ?? 0) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(statusCode: number): boolean {
  return statusCode >= 500 && statusCode < 600;
}

async function callApi(
  method: string,
  requestFactory: () => Promise<Response>,
): Promise<unknown> {
  let lastError: { statusCode: number; description: string } | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let statusCode = 0;
    let description = "";

    try {
      const response = await requestFactory();
      statusCode = response.status;

      let body: TelegramApiResponse | null = null;
      try {
        body = (await response.json()) as TelegramApiResponse;
      } catch {
        body = null;
      }

      if (response.ok && body?.ok) {
        return body.result;
      }

      statusCode = body?.error_code ?? response.status;
      description = body?.description ?? response.statusText ?? "unknown error";
    } catch (err: unknown) {
      statusCode = 0;
      description = err instanceof Error ? err.message : String(err);
    }

    lastError = { statusCode, description };

    const transient = statusCode === 0 || isTransient(statusCode);
    const hasRetriesLeft = attempt < MAX_RETRIES;

    if (transient && hasRetriesLeft) {
      const delay = RETRY_BACKOFF_MS[attempt];
      safeLog("warn", "telegram_retry", {
        method,
        status_code: statusCode,
        attempt: attempt + 1,
        next_delay_ms: delay,
      });
      await sleep(delay);
      continue;
    }

    break;
  }

  const finalStatus = lastError?.statusCode ?? 0;
  const finalDescription = lastError?.description ?? "unknown error";
  safeLog("error", "telegram_failure", {
    method,
    status_code: finalStatus,
  });
  throw new TelegramApiError(method, finalStatus, finalDescription);
}

function postJson(
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = `${API_BASE}${method}`;
  return callApi(method, () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
}

export function verifySecret(req: Request): boolean {
  const expected = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const received = req.headers.get("x-telegram-bot-api-secret-token") ??
    undefined;
  return constantTimeEquals(expected ?? undefined, received ?? undefined);
}

export async function sendMessage(
  chatId: number,
  text: string,
  options?: TelegramSendMessageOptions,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    ...(options ?? {}),
  };
  await postJson("sendMessage", body);
}

export async function sendChatAction(
  chatId: number,
  action: ChatAction,
): Promise<void> {
  await postJson("sendChatAction", { chat_id: chatId, action });
}

export async function getFile(fileId: string): Promise<TelegramFile> {
  const result = await postJson("getFile", { file_id: fileId });
  return result as TelegramFile;
}

export async function downloadFile(filePath: string): Promise<Uint8Array> {
  const url = `${FILE_BASE}${filePath}`;
  const method = "downloadFile";

  let lastError: { statusCode: number; description: string } | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let statusCode = 0;
    let description = "";

    try {
      const response = await fetch(url);
      statusCode = response.status;
      if (response.ok) {
        const buf = await response.arrayBuffer();
        return new Uint8Array(buf);
      }
      description = response.statusText ?? "unknown error";
    } catch (err: unknown) {
      statusCode = 0;
      description = err instanceof Error ? err.message : String(err);
    }

    lastError = { statusCode, description };

    const transient = statusCode === 0 || isTransient(statusCode);
    const hasRetriesLeft = attempt < MAX_RETRIES;
    if (transient && hasRetriesLeft) {
      const delay = RETRY_BACKOFF_MS[attempt];
      safeLog("warn", "telegram_retry", {
        method,
        status_code: statusCode,
        attempt: attempt + 1,
        next_delay_ms: delay,
      });
      await sleep(delay);
      continue;
    }
    break;
  }

  const finalStatus = lastError?.statusCode ?? 0;
  const finalDescription = lastError?.description ?? "unknown error";
  safeLog("error", "telegram_failure", {
    method,
    status_code: finalStatus,
  });
  throw new TelegramApiError(method, finalStatus, finalDescription);
}

export async function sendMessageWithButtons(
  chatId: number,
  text: string,
  buttons: Array<{ text: string; callback_data: string }>,
  parseMode?: "Markdown" | "MarkdownV2" | "HTML",
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    reply_markup: {
      inline_keyboard: [
        buttons.map((b) => ({ text: b.text, callback_data: b.callback_data })),
      ],
    },
  };
  try {
    await postJson("sendMessage", body);
  } catch (err) {
    if (
      parseMode && err instanceof TelegramApiError && err.statusCode === 400
    ) {
      const { parse_mode: _, ...plainBody } = body;
      plainBody.text = (plainBody.text as string).replace(/[_*`\[\]]/g, "");
      await postJson("sendMessage", plainBody);
    } else {
      throw err;
    }
  }
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await postJson("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ?? "",
  });
}

export async function sendDocument(
  chatId: number,
  filename: string,
  bytes: Uint8Array,
  mimeType: string,
  caption?: string,
): Promise<void> {
  const url = `${API_BASE}sendDocument`;
  const method = "sendDocument";

  await callApi(method, () => {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption !== undefined) {
      form.set("caption", caption);
    }

    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([buffer], { type: mimeType });
    form.set("document", blob, filename);
    return fetch(url, { method: "POST", body: form });
  });
}
