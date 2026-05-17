/**
 * End-to-end smoke tests against the deployed Telegram webhook.
 *
 * Reads configuration from the environment so secrets stay out of the repo:
 *
 *   OPENMEMO_WEBHOOK_URL    e.g. https://<project>.supabase.co/functions/v1/telegram-webhook
 *   OPENMEMO_WEBHOOK_SECRET the X-Telegram-Bot-Api-Secret-Token value
 *   OPENMEMO_OWNER_CHAT_ID  numeric chat id of the owner
 *
 * Run:
 *   deno run --allow-net --allow-env tests/e2e.ts
 */

const WEBHOOK = Deno.env.get("OPENMEMO_WEBHOOK_URL");
const SECRET = Deno.env.get("OPENMEMO_WEBHOOK_SECRET");
const OWNER_CHAT_ID = Number(Deno.env.get("OPENMEMO_OWNER_CHAT_ID"));

if (!WEBHOOK || !SECRET || !OWNER_CHAT_ID || Number.isNaN(OWNER_CHAT_ID)) {
  console.error(
    "Missing required env vars: OPENMEMO_WEBHOOK_URL, OPENMEMO_WEBHOOK_SECRET, OPENMEMO_OWNER_CHAT_ID",
  );
  Deno.exit(2);
}

const WEBHOOK_URL: string = WEBHOOK;
const WEBHOOK_SECRET: string = SECRET;

const HEADERS = {
  "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
  "Content-Type": "application/json",
};

interface TestCase {
  name: string;
  messages: string[];
  expectError?: boolean;
}

let passed = 0;
let failed = 0;
const errorMessages: string[] = [];

async function send(text: string): Promise<number> {
  const body = JSON.stringify({
    update_id: Math.floor(Math.random() * 99999),
    message: {
      message_id: Math.floor(Math.random() * 99999),
      chat: { id: OWNER_CHAT_ID, type: "private" },
      from: { id: OWNER_CHAT_ID, first_name: "Owner" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  });
  try {
    const res = await fetch(WEBHOOK_URL, { method: "POST", headers: HEADERS, body });
    return res.status;
  } catch {
    return 0;
  }
}

async function runTest(test: TestCase): Promise<boolean> {
  for (let i = 0; i < test.messages.length; i++) {
    const isLast = i === test.messages.length - 1;
    const status = await send(test.messages[i]);
    const ok = status === 200;
    if (!ok && (isLast || !test.expectError)) {
      errorMessages.push(`  "${test.messages[i]}" -> HTTP ${status}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, test.messages[i].length > 60 ? 4000 : 3000));
  }
  return true;
}

const tests: TestCase[] = [
  { name: "Crear recordatorio simple", messages: ["recuerdame manana a las 9 revisar el correo"] },
  { name: "Crear con shorthand temporal", messages: ["recuerdame en 5m llamar cliente"] },
  { name: "Crear recurrente", messages: ["cada dia a las 9 vitamina D"] },
  { name: "Pregunta sobre pendientes", messages: ["que tengo hoy"] },
  { name: "Saludo", messages: ["hola"] },
  { name: "Cancelar todos", messages: ["borra todos mis recordatorios"] },
];

console.log(`OpenMemo E2E (${tests.length} tests)`);
for (const t of tests) {
  const ok = await runTest(t);
  if (ok) {
    passed++;
    console.log(`  PASS ${t.name}`);
  } else {
    failed++;
    console.log(`  FAIL ${t.name}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(errorMessages.join("\n"));
  Deno.exit(1);
}
