import type { IntentEnvelope, NlpContext } from "./types.ts";
import { safeLog } from "./supabase.ts";

const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ??
  Deno.env.get("DEEPSEEK_API_KEY");
if (!LLM_API_KEY) {
  throw new Error("Missing required env var: LLM_API_KEY");
}

const BASE_URL = (Deno.env.get("LLM_BASE_URL") ?? "https://api.deepseek.com")
  .replace(/\/+$/, "");
const CHAT_ENDPOINT = "/v1/chat/completions";
const EMBEDDINGS_ENDPOINT = "/v1/embeddings";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const BACKOFF_MS = [1_000, 2_000];

const CHAT_MODEL = Deno.env.get("LLM_CHAT_MODEL") ?? "deepseek-chat";
const EMBED_MODEL = Deno.env.get("LLM_EMBED_MODEL") ?? "deepseek-embed";
const EMBEDDING_DIMENSIONS = Number(
  Deno.env.get("LLM_EMBED_DIMENSIONS") ?? 1536,
);

export class DeepSeekError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(`DeepSeek ${endpoint} failed (${statusCode}): ${message}`);
    this.name = "DeepSeekError";
  }
}

const _PARSE_INTENT_TOOL = {
  type: "function",
  function: {
    name: "parse_intent",
    description:
      "Extrae intención y entidades del mensaje del propietario. Devuelve JSON estructurado.",
    parameters: {
      type: "object",
      required: ["intent", "confidence"],
      properties: {
        intent: {
          type: "string",
          enum: [
            "create_reminder",
            "create_list",
            "add_to_list",
            "complete_list_item",
            "remove_list_item",
            "create_task",
            "complete_task",
            "create_memory_bubble",
            "query_park",
            "query_office",
            "store_file",
            "retrieve_file",
            "calendar_query",
            "calendar_create",
            "cancel_reminder",
            "list_reminders",
            "pause_reminder",
            "resume_reminder",
            "update_reminder",
            "add_pre_notifications",
            "help",
            "unknown",
          ],
        },
        confidence: { type: "number" },
        raw_text: { type: "string" },
        reminder_kind: {
          type: "string",
          enum: [
            "static",
            "recurring",
            "dynamic",
            "conditional",
            "escalation",
            "composite",
          ],
        },
        entities: {
          type: "object",
          properties: {
            content: { type: "string" },
            trigger_at: {
              type: "string",
              description:
                "ISO 8601 con offset de la zona horaria del propietario",
            },
            recurrence_rule: { type: "string", description: "RRULE RFC 5545" },
            deadline_at: { type: "string" },
            list_name: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            template_id: { type: "string" },
            template_params: { type: "object" },
            condition: {
              type: "object",
              description: "JSON con predicate_type y params",
            },
            escalation_rule: {
              type: "object",
              description:
                "JSON con policy, interval_minutes o recurrence_rule",
            },
            stop_condition: {
              type: "object",
              description: "JSON con type y params",
            },
            then_action: {
              type: "object",
              description:
                "JSON con type (send_message o create_reminder) y campos",
            },
            pre_notifications: {
              type: "array",
              items: { type: "object" },
              description: "Array de {lead_time_minutes, content_template}",
            },
            re_evaluation_rule: {
              type: "string",
              description: "RRULE para re-evaluación de condicionales",
            },
            task_id: { type: "string" },
            list_item_id: { type: "string" },
            reminder_id: { type: "string" },
            short_id: { type: "string" },
            reply_text: {
              type: "string",
              description:
                "Respuesta conversacional en español para el usuario. Tono: asistente personal cercano, proactivo, breve pero cálido. Usa emojis con moderación.",
            },
            context_updates: {
              type: "array",
              items: { type: "object" },
              description:
                "Array de {category, key, value} con info personal nueva que el usuario compartió. Categorías: personal, work, health, education, preferences.",
            },
          },
        },
      },
    },
  },
} as const;

const PARSE_ONLY_TOOL = {
  type: "function",
  function: {
    name: "parse_intent",
    description:
      "Extrae intención y entidades del mensaje. Solo datos estructurados, sin respuesta conversacional.",
    parameters: {
      type: "object",
      required: ["intent", "confidence"],
      properties: {
        intent: {
          type: "string",
          enum: [
            "create_reminder",
            "create_list",
            "add_to_list",
            "complete_list_item",
            "remove_list_item",
            "create_task",
            "complete_task",
            "create_memory_bubble",
            "query_park",
            "query_office",
            "store_file",
            "retrieve_file",
            "calendar_query",
            "calendar_create",
            "cancel_reminder",
            "list_reminders",
            "pause_reminder",
            "resume_reminder",
            "update_reminder",
            "add_pre_notifications",
            "help",
            "unknown",
          ],
        },
        confidence: { type: "number" },
        raw_text: { type: "string" },
        reminder_kind: {
          type: "string",
          enum: [
            "static",
            "recurring",
            "dynamic",
            "conditional",
            "escalation",
            "composite",
          ],
        },
        entities: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Título reformulado de la acción. Verbo en infinitivo + objeto, 4-8 palabras. Ej: 'revisar el correo', 'comprar leche', 'llamar al dentista'. Extrae del mensaje del usuario pero NO copies literalmente.",
            },
            trigger_at: {
              type: "string",
              description:
                "ISO 8601 con offset de la zona horaria del propietario",
            },
            recurrence_rule: { type: "string", description: "RRULE RFC 5545" },
            deadline_at: {
              type: "string",
              description: "Fecha límite/tope. ISO 8601 con offset.",
            },
            list_name: {
              type: "string",
              description:
                "Nombre de la lista a la que pertenece el elemento (crear o usar existente).",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Etiquetas relevantes extraídas del mensaje.",
            },
            template_id: { type: "string" },
            template_params: { type: "object" },
            condition: { type: "object" },
            escalation_rule: { type: "object" },
            stop_condition: { type: "object" },
            then_action: { type: "object" },
            pre_notifications: { type: "array", items: { type: "object" } },
            re_evaluation_rule: { type: "string" },
            task_id: {
              type: "string",
              description:
                "ID de tarea referenciada (para completar/cancelar).",
            },
            list_item_id: {
              type: "string",
              description: "ID de elemento de lista referenciado.",
            },
            reminder_id: {
              type: "string",
              description:
                "ID de recordatorio referenciado (para pausar/cancelar/actualizar).",
            },
            short_id: {
              type: "string",
              description:
                "Prefijo corto de ID para referencias deícticas ('el de las 9').",
            },
            lead_times_days: {
              type: "array",
              items: { type: "integer", minimum: 0 },
              description:
                "Días de antelación para pre-avisos. Solo úsalo con intent='add_pre_notifications'. Ej: '3, 21 y 1 días antes' → [21, 3, 1]. '1 semana antes' → [7]. 'el día anterior' → [1].",
            },
            trigger_at_confidence: {
              type: "string",
              enum: ["explicit", "inferred", "none"],
              description:
                "Cómo de seguro estás del trigger_at. 'explicit' si el usuario dio fecha Y hora completas. 'inferred' si tuviste que asumir parte (típicamente la hora cuando solo dio el día). 'none' si no hay fecha.",
            },
            events: {
              type: "array",
              description:
                "Cuando el usuario manda VARIOS eventos en un solo mensaje (cronograma, lista de exámenes, agenda), extrae cada uno aquí. Array vacío [] o ausente si el mensaje habla de UN solo evento (entonces usa content + trigger_at).",
              items: {
                type: "object",
                required: ["title", "trigger_at"],
                properties: {
                  title: {
                    type: "string",
                    description: "Nombre/título del evento, conciso.",
                  },
                  trigger_at: {
                    type: "string",
                    description:
                      "ISO 8601 con offset. OBLIGATORIO. Si no hay hora explícita, usa 09:00.",
                  },
                  ends_at: {
                    type: "string",
                    description:
                      "ISO 8601 con offset si el usuario indica fin.",
                  },
                  location: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

const RESPONSE_GENERATOR_TOOL = {
  type: "function",
  function: {
    name: "generate_response",
    description:
      "Genera una respuesta conversacional premium en español y detecta información personal nueva que el usuario compartió.",
    parameters: {
      type: "object",
      required: ["reply_text"],
      properties: {
        reply_text: {
          type: "string",
          description:
            "Respuesta conversacional en español. 2-4 frases. Tono: amigo cercano, inteligente, proactivo, cálido. Personalizada al contexto del usuario. Varía el estilo en cada interacción, nunca uses fórmulas repetitivas. Emojis con moderación y buen gusto. Confirma la acción realizada de forma natural y humana.",
        },
        context_updates: {
          type: "array",
          items: { type: "object" },
          description:
            "Información personal nueva que el usuario compartió en este mensaje. Array de {category, key, value}. Categorías: personal, work, health, education, preferences. Array vacío si el usuario no compartió info personal nueva.",
        },
      },
    },
  },
} as const;

interface CallOptions {
  endpoint: string;
  body: unknown;
}

interface RawHttpResult {
  status: number;
  bodyText: string;
}

async function fetchOnce(opts: CallOptions): Promise<RawHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${opts.endpoint}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return { status: response.status, bodyText };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new DeepSeekError(
        opts.endpoint,
        0,
        `request aborted after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new DeepSeekError(opts.endpoint, 0, `network error: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callDeepSeek(opts: CallOptions): Promise<unknown> {
  let lastError: DeepSeekError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { status, bodyText } = await fetchOnce(opts);

      if (status >= 200 && status < 300) {
        try {
          return JSON.parse(bodyText) as unknown;
        } catch {
          throw new DeepSeekError(
            opts.endpoint,
            0,
            "response body was not valid JSON",
          );
        }
      }

      if (status >= 400 && status < 500) {
        throw new DeepSeekError(
          opts.endpoint,
          status,
          "non-retryable client error",
        );
      }

      lastError = new DeepSeekError(
        opts.endpoint,
        status,
        "server error",
      );
    } catch (err: unknown) {
      if (err instanceof DeepSeekError) {
        if (err.statusCode === 0 || err.statusCode >= 500) {
          lastError = err;
        } else {
          throw err;
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        lastError = new DeepSeekError(opts.endpoint, 0, message);
      }
    }

    if (attempt < MAX_RETRIES) {
      safeLog("warn", "deepseek_retry", {
        endpoint: opts.endpoint,
        attempt: attempt + 1,
        status_code: lastError?.statusCode ?? 0,
      });
      await sleep(BACKOFF_MS[attempt]);
    }
  }

  const finalError = lastError ?? new DeepSeekError(
    opts.endpoint,
    0,
    "exhausted retries with no captured error",
  );
  safeLog("error", "deepseek_failure", {
    endpoint: opts.endpoint,
    status_code: finalError.statusCode,
  });
  throw finalError;
}

function buildParserPrompt(ctx: NlpContext): string {
  const lists = ctx.list_names.length > 0 ? ctx.list_names.join(",") : "-";
  const pending = ctx.pending_short_items.slice(0, 10);
  const pendingStr = pending.length === 0
    ? "-"
    : pending.map((i) =>
      `${i.short_id}:${i.title.substring(0, 40)}${
        i.next_trigger_at ?? i.due_at
          ? "@" + (i.next_trigger_at ?? i.due_at)
          : ""
      }`
    ).join(" | ");

  return [
    `Eres OpenMemo, asistente personal. Tu trabajo es entender QUÉ quiere el usuario y CUÁNDO.`,
    ``,
    `Contexto: now=${ctx.now} tz=${ctx.timezone}`,
    `Listas: ${lists}`,
    `Pendientes: ${pendingStr}`,
    ``,
    `═══ CÓMO DECIDIR LA INTENCIÓN ═══`,
    ``,
    `Lee el mensaje y elige UNA de estas categorías:`,
    ``,
    `─── A) UN SOLO EVENTO/ACCIÓN CON FECHA ───`,
    `intent="create_reminder", llena entities.content + entities.trigger_at.`,
    `Ejemplos:`,
    `  "mañana a las 9 revisar correo" → content="revisar correo", trigger_at=mañana 09:00.`,
    `  "el 15 de junio examen" → content="examen", trigger_at=2026-06-15T09:00.`,
    `  "cada lunes a las 8 gym" → content="gym", recurrence_rule="FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0".`,
    `  "en 5 minutos sacar la pizza" → content="sacar la pizza", trigger_at=now+5min.`,
    ``,
    `─── A2) RESUMEN DIARIO (BUENOS DÍAS / BUENAS NOCHES / AGENDA) ───`,
    `Cuando el usuario pide un saludo automático con su agenda, usa intent="create_reminder", reminder_kind="dynamic" y template_id apropiado.`,
    `Plantillas válidas: "daily_briefing" (qué tienes hoy), "tomorrow_agenda" (qué tienes mañana), "weekly_review" (resumen semanal), "pending_tasks" (tareas pendientes), "next_calendar_event" (próximo evento).`,
    `Ejemplos:`,
    `  "buenos días a las 12 todos los días con lo que tengo hoy" →`,
    `    reminder_kind="dynamic", template_id="daily_briefing", recurrence_rule="FREQ=DAILY;BYHOUR=12;BYMINUTE=0".`,
    `  "cada noche a las 21:00 dime lo de mañana" →`,
    `    reminder_kind="dynamic", template_id="tomorrow_agenda", recurrence_rule="FREQ=DAILY;BYHOUR=21;BYMINUTE=0".`,
    `  "los domingos por la tarde resumen semanal" →`,
    `    reminder_kind="dynamic", template_id="weekly_review", recurrence_rule="FREQ=WEEKLY;BYDAY=SU;BYHOUR=18;BYMINUTE=0".`,
    `  "todas las mañanas a las 8 mis pendientes" →`,
    `    reminder_kind="dynamic", template_id="pending_tasks", recurrence_rule="FREQ=DAILY;BYHOUR=8;BYMINUTE=0".`,
    `Cuando uses dynamic, NO pongas trigger_at — pon recurrence_rule. NO pongas content (lo genera la plantilla en el momento).`,
    ``,
    `─── B) MÚLTIPLES EVENTOS EN UN MENSAJE ───`,
    `intent="create_reminder", llena entities.events[] con UNA entrada por evento.`,
    `Detecta esto cuando el mensaje incluye un cronograma, lista de exámenes, agenda pegada,`,
    `o varias fechas claramente diferenciadas. NO uses content/trigger_at en este caso.`,
    `Ejemplos:`,
    `  "examen de mates el 5 de junio y química el 12" → events=[{title:"examen mates", trigger_at:"2026-06-05T09:00..."}, {title:"examen química", trigger_at:"2026-06-12T09:00..."}]`,
    `  Cronograma con 3 evaluaciones (HSK 09 Sep 09:00, Next.js 14 Oct 15:00, Supabase 18 Nov 11:00) → events con 3 entradas, cada una con title+trigger_at correctos.`,
    `Reglas para events[]:`,
    `  - title: el NOMBRE real del evento (asignatura, examen, materia), no la fecha.`,
    `  - trigger_at: ISO 8601 con offset de la zona del usuario. SIEMPRE obligatorio.`,
    `  - Formatos de mes que debes reconocer: "septiembre", "Sep", "sep", "9", "09", "Sept", "septembre".`,
    `  - Formatos de fecha: "09 Sep 2026", "9/9/2026", "09-09-2026", "9 de septiembre de 2026", "miércoles 9 sep".`,
    `  - Si la línea da hora (ej "09:00 - 11:30"), usa la hora de inicio en trigger_at y la de fin en ends_at.`,
    `  - Si no hay hora explícita en una entrada, usa 09:00 local.`,
    ``,
    `─── C) PREGUNTA SOBRE DATOS GUARDADOS / CHARLA SOBRE AGENDA ───`,
    `  "qué tengo hoy/mañana/esta semana", "qué exámenes hay", "lista mis recordatorios" → intent="list_reminders".`,
    `  "cuándo es X", "tengo algo el viernes", "qué hay en noviembre" → intent="calendar_query".`,
    `  "explícame mis exámenes", "cuál es el próximo", "cuántos exámenes me quedan", "resume mi semana" → intent="list_reminders" (Pass 2 generará la respuesta natural usando pendientes).`,
    `  "busca apuntes de X", "encuentra la nota sobre Y" → intent="query_park".`,
    `  Importante: estas consultas SIEMPRE las clasificas aquí, NO en A). Aunque el usuario use "muéstrame", "dime", "qué", "cuándo", etc.`,
    ``,
    `─── D) CANCELAR/COMPLETAR/PAUSAR ───`,
    `  "cancela X", "borra X", "elimina X" → intent="cancel_reminder", entities.content=referencia al item.`,
    `  "borra todos mis recordatorios", "elimina todo", "cancela todas mis alertas" → intent="cancel_reminder", entities.content="todos los recordatorios" (literal). NO inventes un único item.`,
    `  "ya hice X", "completé X" → intent="complete_task" si era tarea, ack si era reminder.`,
    `  "pausa X" → intent="pause_reminder".`,
    ``,
    `─── D2) AÑADIR PRE-AVISOS A UN RECORDATORIO EXISTENTE ───`,
    `Cuando el usuario pide pre-avisos sobre un recordatorio que YA tiene (típicamente el último creado), usa:`,
    `  intent="add_pre_notifications", lead_times_days=[N1, N2, ...], y opcionalmente reminder_id/short_id si lo identifica.`,
    `Ejemplos:`,
    `  "para esta alerta envíame 3, 21 y 1 días antes" → lead_times_days=[21, 3, 1].`,
    `  "para el examen del 9 sep avísame el día anterior y una semana antes" → reminder_id (resolver por título), lead_times_days=[7, 1].`,
    `  "ponme un aviso 2 días antes para todos" → lead_times_days=[2] (sin reminder_id, aplica a todos los del mensaje anterior).`,
    `Reglas:`,
    `  - lead_times_days debe ser un array de enteros > 0, siempre en DÍAS.`,
    `  - "1 semana antes" = 7. "2 semanas" = 14. "1 mes" = 30.`,
    `  - Si dice "30 minutos antes" o "2 horas antes" → NO uses este intent (esos son pre_notifications con minutos, intent normal con campo pre_notifications).`,
    ``,
    `─── E) GUARDAR NOTA / CONOCIMIENTO ───`,
    `  "apunta que X", "recuerda que prefiero Y" → intent="create_memory_bubble".`,
    ``,
    `─── F) CONVERSACIÓN SIN ACCIÓN ───`,
    `Saludos, agradecimientos, charla, preguntas sin contexto claro → intent="unknown" confidence=0.5.`,
    ``,
    `═══ CONVERTIR EXPRESIONES TEMPORALES ═══`,
    ``,
    `Tu now=${ctx.now} (${ctx.timezone}). Resuelve TODO a ISO 8601 con offset.`,
    `  "ahora" → now`,
    `  "en N minutos/horas/días" → now + N`,
    `  "hoy a las X" → fecha de now con hora X`,
    `  "mañana" → now+1d (si no hay hora, 09:00)`,
    `  "pasado mañana" → now+2d`,
    `  "el lunes/martes/..." → próximo día de la semana`,
    `  "esta tarde" → hoy 16:00, "esta noche" → hoy 21:00, "mañana por la mañana" → mañana 09:00`,
    `  "el día 9 de cada mes" → recurrence_rule="FREQ=MONTHLY;BYMONTHDAY=9"`,
    `  "cada lunes y miércoles" → recurrence_rule="FREQ=WEEKLY;BYDAY=MO,WE"`,
    ``,
    `═══ REGLAS DE ORO ═══`,
    ``,
    `1. NUNCA inventes contenido que no esté en el mensaje. Si no entiendes el QUÉ, intent="unknown".`,
    `2. NUNCA pongas trigger_at en el pasado. Si no hay fecha clara, NO crees recordatorio: intent="unknown" confidence=0.5.`,
    `3. NUNCA defaultees a "en 5 minutos" si el usuario no dijo eso.`,
    `4. Si el mensaje tiene 2+ fechas con sus actividades, USA events[]. No metas todo en un solo content.`,
    `5. Si el mensaje es ambiguo entre A) y C) (ej "qué hago el viernes"), elige C).`,
    `6. Confidence: 0.9+ si entiendes claramente, 0.6-0.8 si hay alguna ambigüedad menor, <0.6 si dudas.`,
    `7. trigger_at_confidence: marca "explicit" si dio fecha Y hora; "inferred" si asumiste la hora (ej. solo dio el día); "none" si no hay fecha. Esto se usa para confirmar al usuario.`,
  ].join("\n");
}

function buildGeneratorPrompt(
  envelope: IntentEnvelope,
  ctx: NlpContext,
): string {
  const owner = (ctx.owner_context && ctx.owner_context.length > 0)
    ? ctx.owner_context.map((c) => `${c.key}=${c.value}`).join(" | ")
    : "sin info aún";

  const pending = ctx.pending_short_items.slice(0, 8);
  const pendingStr = pending.length === 0
    ? "ninguno"
    : pending.map((i) =>
      `${i.title}${i.next_trigger_at ? " @ " + i.next_trigger_at : ""}`
    ).join(" | ");

  const _eventsStr = (ctx.upcoming_events && ctx.upcoming_events.length > 0)
    ? ctx.upcoming_events.slice(0, 3).map((e) => `${e.title}@${e.starts_at}`)
      .join(" | ")
    : "ninguno";

  const _staleStr = (ctx.stale_reminders && ctx.stale_reminders.length > 0)
    ? ctx.stale_reminders.slice(0, 3).join(" | ")
    : "ninguno";

  const nowDate = new Date(ctx.now);
  const hour = nowDate.getHours();
  const dayOfWeek = nowDate.toLocaleDateString("es-ES", { weekday: "long" });
  const timeOfDay = hour < 6
    ? "madrugada"
    : hour < 12
    ? "mañana"
    : hour < 15
    ? "mediodía"
    : hour < 20
    ? "tarde"
    : "noche";
  const isWeekend = nowDate.getDay() === 0 || nowDate.getDay() === 6;

  const cleanEntities: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope.entities)) {
    if (
      v !== undefined && v !== null &&
      !(typeof v === "object" && Object.keys(v as object).length === 0)
    ) {
      cleanEntities[k] = typeof v === "string" && v.length > 80
        ? v.substring(0, 80) + "..."
        : v;
    }
  }

  const actionSummary =
    `intent=${envelope.intent} confidence=${envelope.confidence} entities=${
      JSON.stringify(cleanEntities)
    }`;

  const isConversational = envelope.intent === "unknown";

  return [
    `You are OpenMemo, a personal assistant. Efficient, direct, no filler.`,
    ``,
    `CONTEXT: now=${ctx.now} (${timeOfDay}, ${dayOfWeek}${
      isWeekend ? ", weekend" : ""
    })`,
    `User: ${owner} | Pending: ${pendingStr}`,
    ``,
    `ACTION: ${actionSummary}`,
    `MODE: ${isConversational ? "CONVERSATION" : "ACTION"}`,
    ``,
    `RESPONSE FORMAT:`,
    `- 2 lines max. Be concise.`,
    `- First line: emoji + confirmation with the key data (what, when, where).`,
    `- Second line only if relevant: conflict with another item, or unconfirmed pending notes.`,
    `- Never question the user's choices. If they said "in 1m", honour it.`,
    `- No filler, no paragraphs, no "anything else?".`,
    ``,
    `ACTION MODE examples:`,
    `  create_reminder: "📬 check inbox → tomorrow 09:00"`,
    `  recurring: "💊 vitamin D → every day 09:00"`,
    `  cancel_reminder: "❌ Cancelled: check inbox"`,
    `  list_reminders: "📌 3 pending: inbox (tomorrow 9), gym (today 18), call mom (fri 12)"`,
    `  complete_task: "✅ Task done: send report"`,
    ``,
    `CONVERSATION MODE: you have pending items in the context. Use them.`,
    `- Complaint/error: apologise briefly, explain what happened, offer to fix.`,
    `- Question about an item: answer from pendingStr with real data.`,
    `- Correction: acknowledge it and confirm the change.`,
    `- Greeting: short hello + a one-liner about pending if any.`,
    `- Low mood: empathise in 1 line.`,
    `- Thanks: 1 line.`,
    `- Goodbye: 1 line.`,
    ``,
    `CONTEXT_UPDATES: if the user shared a new personal fact, return [{category, key, value}]. Empty array otherwise.`,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractToolArguments(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message)) return null;
  const toolCalls = message.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const call = toolCalls[0];
  if (!isRecord(call)) return null;
  const fn = call.function;
  if (!isRecord(fn)) return null;
  const args = fn.arguments;
  return typeof args === "string" ? args : null;
}

function validateEnvelope(
  parsed: unknown,
  rawText: string,
): IntentEnvelope {
  if (!isRecord(parsed)) {
    throw new DeepSeekError(
      CHAT_ENDPOINT,
      0,
      "tool_call.arguments did not decode to an object",
    );
  }
  if (typeof parsed.intent !== "string") {
    throw new DeepSeekError(
      CHAT_ENDPOINT,
      0,
      "envelope is missing required string field `intent`",
    );
  }
  if (typeof parsed.confidence !== "number") {
    throw new DeepSeekError(
      CHAT_ENDPOINT,
      0,
      "envelope is missing required number field `confidence`",
    );
  }

  if (typeof parsed.raw_text !== "string") {
    parsed.raw_text = rawText;
  }

  if (!isRecord(parsed.entities)) {
    parsed.entities = {};
  }

  return parsed as unknown as IntentEnvelope;
}

export async function parseIntent(
  text: string,
  ctx: NlpContext,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<IntentEnvelope> {
  const historyMessages = (history && history.length > 0)
    ? history
      .filter((t) => t.content && t.content.trim().length > 0)
      .map((t) => ({ role: t.role, content: t.content.substring(0, 600) }))
    : [];

  const messages = [
    { role: "system" as const, content: buildParserPrompt(ctx) },
    ...historyMessages,
    { role: "user" as const, content: text },
  ];

  const body = {
    model: CHAT_MODEL,
    messages,
    tools: [PARSE_ONLY_TOOL],
    tool_choice: {
      type: "function",
      function: { name: "parse_intent" },
    },
    temperature: 0,
  };

  const payload = await callDeepSeek({ endpoint: CHAT_ENDPOINT, body });

  const argsString = extractToolArguments(payload);
  if (argsString === null) {
    throw new DeepSeekError(
      CHAT_ENDPOINT,
      0,
      "response did not contain a `parse_intent` tool_call",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(argsString);
  } catch {
    let repaired = argsString;

    let braceCount = 0;
    let lastValidEnd = -1;
    for (let i = 0; i < repaired.length; i++) {
      if (repaired[i] === "{") braceCount++;
      else if (repaired[i] === "}") {
        braceCount--;
        if (braceCount === 0) {
          lastValidEnd = i + 1;
          break;
        }
      }
    }
    if (lastValidEnd > 0) {
      repaired = repaired.substring(0, lastValidEnd);
    }

    if (braceCount > 0) {
      repaired = repaired + "}".repeat(braceCount);
    }

    try {
      parsed = JSON.parse(repaired);
    } catch (err2: unknown) {
      const jsonMatch = argsString.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          const message = err2 instanceof Error ? err2.message : String(err2);
          throw new DeepSeekError(
            CHAT_ENDPOINT,
            0,
            `tool_call.arguments was not valid JSON: ${message}`,
          );
        }
      } else {
        const message = err2 instanceof Error ? err2.message : String(err2);
        throw new DeepSeekError(
          CHAT_ENDPOINT,
          0,
          `tool_call.arguments was not valid JSON: ${message}`,
        );
      }
    }
  }

  return validateEnvelope(parsed, text);
}

function parseArgsWithRepair(argsString: string): unknown {
  try {
    return JSON.parse(argsString);
  } catch {
    let repaired = argsString;

    let braceCount = 0;
    let lastValidEnd = -1;
    for (let i = 0; i < repaired.length; i++) {
      if (repaired[i] === "{") braceCount++;
      else if (repaired[i] === "}") {
        braceCount--;
        if (braceCount === 0) {
          lastValidEnd = i + 1;
          break;
        }
      }
    }
    if (lastValidEnd > 0) {
      repaired = repaired.substring(0, lastValidEnd);
    }
    if (braceCount > 0) {
      repaired = repaired + "}".repeat(braceCount);
    }

    try {
      return JSON.parse(repaired);
    } catch (err2: unknown) {
      const jsonMatch = argsString.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          const message = err2 instanceof Error ? err2.message : String(err2);
          throw new DeepSeekError(
            CHAT_ENDPOINT,
            0,
            `tool_call.arguments was not valid JSON: ${message}`,
          );
        }
      } else {
        const message = err2 instanceof Error ? err2.message : String(err2);
        throw new DeepSeekError(
          CHAT_ENDPOINT,
          0,
          `tool_call.arguments was not valid JSON: ${message}`,
        );
      }
    }
  }
}

export interface PremiumResponse {
  reply_text: string;
  context_updates?: Array<{ category: string; key: string; value: string }>;
}

export async function generateResponse(
  envelope: IntentEnvelope,
  ctx: NlpContext,
): Promise<PremiumResponse> {
  const messages = [
    { role: "system" as const, content: buildGeneratorPrompt(envelope, ctx) },
    { role: "user" as const, content: "Genera la respuesta para esta acción." },
  ];

  const body = {
    model: CHAT_MODEL,
    messages,
    tools: [RESPONSE_GENERATOR_TOOL],
    tool_choice: {
      type: "function",
      function: { name: "generate_response" },
    },
    temperature: 0.7,
  };

  const payload = await callDeepSeek({ endpoint: CHAT_ENDPOINT, body });

  const argsString = extractToolArguments(payload);
  if (argsString === null) {
    throw new DeepSeekError(
      CHAT_ENDPOINT,
      0,
      "response did not contain a `generate_response` tool_call",
    );
  }

  const parsed = parseArgsWithRepair(argsString);

  if (!isRecord(parsed) || typeof parsed.reply_text !== "string") {
    throw new DeepSeekError(
      CHAT_ENDPOINT,
      0,
      "generate_response missing required string field `reply_text`",
    );
  }

  const result: PremiumResponse = { reply_text: parsed.reply_text };
  if (Array.isArray(parsed.context_updates)) {
    result.context_updates = parsed.context_updates as Array<{
      category: string;
      key: string;
      value: string;
    }>;
  }

  return result;
}

export async function narrateBriefing(
  bullets: string,
  greeting: string,
  tone: "morning" | "night",
): Promise<string | null> {
  const openerHint = tone === "morning"
    ? "Open with a warm 'good morning' style hello and frame the day like an assistant who knows the user."
    : "Open with a night-time hello and prep the user for tomorrow or close the day.";

  const system = [
    `You are OpenMemo, a personal assistant. Rewrite a structured briefing into one natural paragraph.`,
    ``,
    `Rules:`,
    `- 2 to 4 sentences. No bullets. No invented data.`,
    `- ${openerHint}`,
    `- Highlight the most important item (a heavy exam, a delivery, a medical appointment).`,
    `- If the day is free, say it warmly.`,
    `- 1 to 3 items: name them with their times. 4+: group them ("3 meetings in the morning and...") and only name the relevant ones.`,
    `- Warm tone, concise. No questions at the end. No "anything else?".`,
    `- Suggested greeting: "${greeting}". Reuse or vary it.`,
    `- Reply in the user's language; pick it up from the briefing text.`,
  ].join("\n");

  const body = {
    model: CHAT_MODEL,
    messages: [
      { role: "system" as const, content: system },
      {
        role: "user" as const,
        content: `Structured briefing:\n\n${bullets}`,
      },
    ],
    temperature: 0.5,
  };

  try {
    const payload = await callDeepSeek({ endpoint: CHAT_ENDPOINT, body });
    if (!isRecord(payload)) return null;
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0];
    if (!isRecord(first)) return null;
    const message = first.message;
    if (!isRecord(message)) return null;
    const content = message.content;
    if (typeof content !== "string") return null;
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function composeReminderDelivery(
  content: string,
  localTime: string,
  isCritical: boolean,
): Promise<string | null> {
  const urgency = isCritical
    ? "It is important."
    : "Warm and close tone, no urgency.";
  const system = [
    `You are OpenMemo, a personal assistant. Write ONE reminder delivery for the owner.`,
    ``,
    `Rules:`,
    `- 1 sentence max, 2 if needed. Natural and human, never quote the content literally.`,
    `- Weave the content into the sentence, not as a citation.`,
    `- Mention the local time at the start or end (you have it in localTime).`,
    `- No generic greetings. Go straight to the reminder.`,
    `- ${urgency}`,
    `- No emoji at the start. At most one emoji at the end if it fits.`,
    `- Don't add reply instructions, the system appends those.`,
    `- Vary the wording.`,
    `- Reply in the user's language inferred from the content.`,
  ].join("\n");

  const userMsg = `localTime: ${localTime}\ncontent: ${content}`;

  const body = {
    model: CHAT_MODEL,
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: userMsg },
    ],
    temperature: 0.7,
  };

  try {
    const payload = await callDeepSeek({ endpoint: CHAT_ENDPOINT, body });
    if (!isRecord(payload)) return null;
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0];
    if (!isRecord(first)) return null;
    const message = first.message;
    if (!isRecord(message)) return null;
    const out = message.content;
    if (typeof out !== "string") return null;
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function extractEmbedding(payload: unknown): number[] | null {
  if (!isRecord(payload)) return null;
  const data = payload.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (!isRecord(first)) return null;
  const embedding = first.embedding;
  if (!Array.isArray(embedding)) return null;

  for (const v of embedding) {
    if (typeof v !== "number") return null;
  }
  return embedding as number[];
}

export async function embed(text: string): Promise<number[]> {
  const body = {
    model: EMBED_MODEL,
    input: text,
  };

  const payload = await callDeepSeek({
    endpoint: EMBEDDINGS_ENDPOINT,
    body,
  });

  const vector = extractEmbedding(payload);
  if (vector === null) {
    throw new DeepSeekError(
      EMBEDDINGS_ENDPOINT,
      0,
      "response did not contain a numeric `data[0].embedding` array",
    );
  }
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new DeepSeekError(
      EMBEDDINGS_ENDPOINT,
      0,
      `embedding length ${vector.length} != expected ${EMBEDDING_DIMENSIONS}`,
    );
  }
  return vector;
}
