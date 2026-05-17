import { db } from "./supabase.ts";

export type OnboardingLanguage = "es" | "en";

const PROMPT_ASK: Record<OnboardingLanguage, string> = {
  es:
    "Hola. Antes de empezar dime que hora es ahora donde estas (HH:MM, formato 24h). Asi te aviso a la hora correcta.",
  en:
    "Hi. Before we start, tell me your current local time (HH:MM, 24h format). I will use it to deliver reminders at the right hour.",
};

const PROMPT_RETRY: Record<OnboardingLanguage, string> = {
  es: "No entendi la hora. Mandame solo HH:MM (por ejemplo 14:30 o 03:05).",
  en: "I could not parse that time. Send only HH:MM (e.g. 14:30 or 03:05).",
};

const PROMPT_DONE: Record<OnboardingLanguage, string> = {
  es: "Listo, ya estamos sincronizados. Cuentame que recordatorio quieres.",
  en: "All set. Tell me what you want me to remember.",
};

const HHMM_RE = /\b([01]?\d|2[0-3])[:.h\s]([0-5]\d)\b/;

export function parseTimeOfDay(
  text: string,
): { hour: number; minute: number } | null {
  const m = HHMM_RE.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function ianaForReportedTime(
  hour: number,
  minute: number,
  now: Date = new Date(),
): string {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const localMinutes = hour * 60 + minute;
  let diff = localMinutes - utcMinutes;
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;

  const offsetMin = Math.round(diff / 15) * 15;

  const COMMON: Record<number, string> = {
    [-5 * 60]: "America/Bogota",
    [-4 * 60]: "America/Santiago",
    [-3 * 60]: "America/Argentina/Buenos_Aires",
    [-6 * 60]: "America/Mexico_City",
    [-7 * 60]: "America/Denver",
    [-8 * 60]: "America/Los_Angeles",
    [0]: "Europe/London",
    [60]: "Europe/Madrid",
    [120]: "Europe/Athens",
    [180]: "Europe/Moscow",
    [330]: "Asia/Kolkata",
    [480]: "Asia/Singapore",
    [540]: "Asia/Tokyo",
    [600]: "Australia/Sydney",
  };
  const named = COMMON[offsetMin];
  if (named) return named;

  const wholeHours = Math.round(offsetMin / 60);
  if (wholeHours === 0) return "UTC";
  const candidate = wholeHours > 0
    ? `Etc/GMT-${wholeHours}`
    : `Etc/GMT+${Math.abs(wholeHours)}`;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(
      new Date(),
    );
    return candidate;
  } catch {
    return "UTC";
  }
}

export interface OnboardingResult {
  reply: string;

  intercept: boolean;
}

export async function runOnboardingStep(
  ownerId: number,
  text: string,
  language: OnboardingLanguage,
  alreadyAsked: boolean,
): Promise<OnboardingResult> {
  if (!alreadyAsked) {
    await db.from("owner").update({ tz_prompt_sent: true }).eq("id", ownerId);
    return { reply: PROMPT_ASK[language], intercept: true };
  }

  const parsed = parseTimeOfDay(text);
  if (!parsed) {
    return { reply: PROMPT_RETRY[language], intercept: true };
  }

  const tz = ianaForReportedTime(parsed.hour, parsed.minute);
  await db.from("owner").update({ timezone: tz, tz_confirmed: true }).eq(
    "id",
    ownerId,
  );

  return { reply: PROMPT_DONE[language], intercept: true };
}
