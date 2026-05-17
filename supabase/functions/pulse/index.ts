import {
  detectBirthdayWindows,
  detectCollisions,
  detectIdlePeriod,
  detectStaleHabits,
  enqueueNudges,
  pickNextNudge,
} from "../_shared/pulse.ts";
import { db } from "../_shared/supabase.ts";
import { sendMessage } from "../_shared/telegram.ts";

const OWNER_CHAT_ID = Number(Deno.env.get("OWNER_CHAT_ID") ?? 0);

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const sendNow = url.searchParams.get("send") === "1";

  const candidates = (await Promise.all([
    detectCollisions(),
    detectBirthdayWindows(),
    detectStaleHabits(),
    detectIdlePeriod(),
  ])).flat();

  const enqueued = dryRun ? 0 : await enqueueNudges(candidates);

  let delivered: string | null = null;
  if (sendNow && OWNER_CHAT_ID > 0) {
    const next = await pickNextNudge();
    if (next) {
      const text = formatNudge(next);
      try {
        await sendMessage(OWNER_CHAT_ID, text);
        await db.from("proactive_nudge")
          .update({ delivered_at: new Date().toISOString() })
          .eq("id", next.id);
        delivered = next.id;
      } catch (err) {
        return jsonResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          enqueued,
          candidates: candidates.length,
        }, 500);
      }
    }
  }

  return jsonResponse({
    ok: true,
    candidates: candidates.length,
    enqueued,
    delivered,
    dry_run: dryRun,
  }, 200);
});

function formatNudge(
  n: { kind: string; reason: string; payload: Record<string, unknown> },
): string {
  switch (n.kind) {
    case "collision": {
      const day = n.payload.day as string;
      const items = (n.payload.items as Array<{ title: string }>) ?? [];
      const titles = items.slice(0, 4).map((i) => `- ${i.title}`).join("\n");
      const more = items.length > 4 ? `\n+${items.length - 4} mas` : "";
      return `Heads up: el ${day} tienes varias cosas:\n${titles}${more}\nAvisame si quieres mover algo.`;
    }
    case "birthday_window": {
      const days = n.payload.days as number;
      const name = n.payload.name as string;
      if (days === 1) return `Manana cumple ${name}. Mensaje, llamada o regalo?`;
      return `${days} dias para el cumple de ${name}. Quieres pensar el regalo ya?`;
    }
    case "stale_habit": {
      const overdue = n.payload.overdue_days as number;
      const title = n.payload.title as string;
      const lostStreak = n.payload.streak_lost === true;
      if (lostStreak) {
        return `Llevabas racha con "${title}" y ya van ${overdue} dia${
          overdue === 1 ? "" : "s"
        } sin marcarlo. Hoy?`;
      }
      return `Hace ${overdue} dia${overdue === 1 ? "" : "s"} que no haces "${title}". Te ayudo a retomar?`;
    }
    case "idle": {
      const days = n.payload.days_since_last as number;
      return `Hola, ${days} dias sin escribir. Sigues por aqui?`;
    }
    default:
      return n.reason;
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
