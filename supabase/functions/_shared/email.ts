import { safeLog } from "./supabase.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const OWNER_EMAIL = Deno.env.get("OWNER_EMAIL");

if (!RESEND_API_KEY) {
  console.warn("email.ts: RESEND_API_KEY not set — email backup disabled");
}

if (!OWNER_EMAIL) {
  console.warn("email.ts: OWNER_EMAIL not set — email backup disabled");
}

const RESEND_BASE = "https://api.resend.com";
const FROM_EMAIL = "onboarding@resend.dev";

interface ResendPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(
  subject: string,
  text: string,
  html?: string,
): Promise<boolean> {
  const result = await sendEmailWithReason(subject, text, html);
  return result.ok;
}

export async function sendEmailWithReason(
  subject: string,
  text: string,
  html?: string,
): Promise<
  {
    ok: boolean;
    reason?: "not_configured" | "remote_error" | "exception";
    detail?: string;
  }
> {
  if (!RESEND_API_KEY || !OWNER_EMAIL) {
    return { ok: false, reason: "not_configured" };
  }

  const payload: ResendPayload = {
    from: FROM_EMAIL,
    to: OWNER_EMAIL,
    subject,
    text,
  };
  if (html) payload.html = html;

  try {
    const res = await fetch(`${RESEND_BASE}/emails`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      safeLog("warn", "email_send_failed", {
        status: res.status,
        error: errText.substring(0, 200),
      });
      return { ok: false, reason: "remote_error", detail: `${res.status}` };
    }

    safeLog("info", "email_sent", { subject: subject.substring(0, 60) });
    return { ok: true };
  } catch (err) {
    safeLog("warn", "email_send_exception", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: "exception",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendReminderEmail(
  content: string,
  triggerAt?: string,
  isCritical?: boolean,
  timezone: string = "UTC",
  ownerName: string = "",
): Promise<boolean> {
  const fmtOptions: Intl.DateTimeFormatOptions = triggerAt
    ? { timeZone: timezone, dateStyle: "short", timeStyle: "short" }
    : { timeZone: timezone, timeStyle: "short" };
  const dateStr = (triggerAt
    ? new Date(triggerAt)
    : new Date())
    .toLocaleString("es-ES", fmtOptions);

  const urgencyTag = isCritical ? "🚨 " : "";
  const subject = `${urgencyTag}⏰ Recordatorio: ${content.substring(0, 50)}`;
  const greeting = ownerName ? `Hola ${ownerName},` : "Hola,";
  const text = [
    greeting,
    ``,
    `${urgencyTag}Tienes un recordatorio:`,
    ``,
    `  ${content}`,
    triggerAt ? `  📅 ${dateStr}` : "",
    ``,
    `— OpenMemo`,
    ``,
    `Este es un backup automático. Ignóralo si ya confirmaste en Telegram.`,
  ].filter(Boolean).join("\n");

  const html = [
    `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:20px;">`,
    `<h2 style="margin:0 0 8px">${urgencyTag}⏰ ${content}</h2>`,
    triggerAt ? `<p style="color:#666;margin:0 0 16px">📅 ${dateStr}</p>` : "",
    `<hr style="border:none;border-top:1px solid #eee">`,
    `<p style="color:#999;font-size:12px">Backup automático de OpenMemo. Ignora si ya confirmaste en Telegram.</p>`,
    `</div>`,
  ].join("\n");

  return sendEmail(subject, text, html);
}
