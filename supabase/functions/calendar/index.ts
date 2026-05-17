import { db } from "../_shared/supabase.ts";

interface Entry {
  id: string;
  source: "event" | "reminder";
  title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  description: string | null;
  tags: string[];
}

interface OwnerLite {
  timezone: string;
  language: string | null;
  display_name: string | null;
}

const HORIZON_DAYS = 90;
const PAST_BUFFER_DAYS = 1;

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  if (!token) return html(unauthorizedPage("en"), 401);

  const { data: access } = await db.from("calendar_access")
    .select("token")
    .eq("id", 1)
    .maybeSingle();
  const expected = (access as { token: string } | null)?.token ?? "";
  if (!expected || token !== expected) {
    return html(unauthorizedPage("en"), 401);
  }

  const owner = await loadOwner();

  const fromIso = new Date(Date.now() - PAST_BUFFER_DAYS * 86_400_000)
    .toISOString();
  const toIso = new Date(Date.now() + HORIZON_DAYS * 86_400_000).toISOString();

  const { data, error } = await db
    .from("calendar_entries")
    .select(
      "id, source, title, starts_at, ends_at, location, description, tags",
    )
    .gte("starts_at", fromIso)
    .lte("starts_at", toIso)
    .order("starts_at", { ascending: true });

  if (error) return html(errorPage(error.message, owner.language ?? "en"), 500);

  const entries = (data ?? []) as Entry[];

  const view = url.searchParams.get("view") === "list" ? "list" : "month";
  const monthOffset = Number(url.searchParams.get("m") ?? 0) || 0;

  return html(
    renderPage(entries, owner, { view, monthOffset, token }),
    200,
  );
});

async function loadOwner(): Promise<OwnerLite> {
  const { data } = await db.from("owner")
    .select("timezone, language, display_name")
    .eq("id", 1)
    .maybeSingle();
  const row = data as Partial<OwnerLite> | null;
  return {
    timezone: row?.timezone ?? "UTC",
    language: row?.language ?? "en",
    display_name: row?.display_name ?? null,
  };
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function localeFor(language: string): string {
  return language === "es" ? "es-ES" : "en-US";
}

interface Strings {
  title: string;
  subtitle: (zone: string) => string;
  empty: string;
  reminder: string;
  event: string;
  today: string;
  prev: string;
  next: string;
  list: string;
  month: string;
  refresh: string;
  unauthorized_title: string;
  unauthorized_body: string;
  error_title: string;
}

const STRINGS: Record<"es" | "en", Strings> = {
  en: {
    title: "Your calendar",
    subtitle: (z) => `Next ${HORIZON_DAYS} days · ${z}`,
    empty: `Nothing in the next ${HORIZON_DAYS} days.`,
    reminder: "reminder",
    event: "event",
    today: "today",
    prev: "Previous",
    next: "Next",
    list: "List",
    month: "Month",
    refresh: "Reload",
    unauthorized_title: "Restricted",
    unauthorized_body:
      "A valid token is required. Append ?t=YOUR_TOKEN to the URL.",
    error_title: "Temporary error",
  },
  es: {
    title: "Tu agenda",
    subtitle: (z) => `Próximos ${HORIZON_DAYS} días · ${z}`,
    empty: `No hay nada en los próximos ${HORIZON_DAYS} días.`,
    reminder: "recordatorio",
    event: "evento",
    today: "hoy",
    prev: "Anterior",
    next: "Siguiente",
    list: "Lista",
    month: "Mes",
    refresh: "Recargar",
    unauthorized_title: "Acceso restringido",
    unauthorized_body: "Necesitas un token válido. Añade ?t=tu_token a la URL.",
    error_title: "Error temporal",
  },
};

function strings(language: string | null | undefined): Strings {
  return language === "es" ? STRINGS.es : STRINGS.en;
}

function dayKey(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTime(iso: string, tz: string, lang: string): string {
  return new Intl.DateTimeFormat(localeFor(lang), {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: lang !== "es",
  }).format(new Date(iso));
}

function formatLongDay(isoDate: string, tz: string, lang: string): string {
  return new Intl.DateTimeFormat(localeFor(lang), {
    timeZone: tz,
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(new Date(isoDate + "T12:00:00Z"));
}

function groupByDay(entries: Entry[], tz: string): Map<string, Entry[]> {
  const m = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = dayKey(new Date(e.starts_at), tz);
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(e);
  }
  return m;
}

function renderPage(
  entries: Entry[],
  owner: OwnerLite,
  opts: { view: "month" | "list"; monthOffset: number; token: string },
): string {
  const lang = owner.language ?? "en";
  const t = strings(lang);
  const tz = owner.timezone;
  const grouped = groupByDay(entries, tz);

  const body = opts.view === "list"
    ? renderList(entries, grouped, tz, lang, t)
    : renderMonth(grouped, tz, lang, t, opts.monthOffset, opts.token);

  const linkBase = `?t=${encodeURIComponent(opts.token)}`;
  const tabs = `
    <nav class="tabs">
      <a class="${
    opts.view === "month" ? "active" : ""
  }" href="${linkBase}&view=month">${t.month}</a>
      <a class="${
    opts.view === "list" ? "active" : ""
  }" href="${linkBase}&view=list">${t.list}</a>
    </nav>`;

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(t.title)}</title>
${baseStyles()}
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${escapeHtml(t.title)}</h1>
      <p class="sub">${escapeHtml(t.subtitle(tz))}</p>
    </header>
    ${tabs}
    ${body}
    <footer>
      <a href="javascript:location.reload()">${escapeHtml(t.refresh)}</a>
      · OpenMemo
    </footer>
  </div>
</body>
</html>`;
}

function renderList(
  entries: Entry[],
  grouped: Map<string, Entry[]>,
  tz: string,
  lang: string,
  t: Strings,
): string {
  if (entries.length === 0) {
    return `<p class="empty">${escapeHtml(t.empty)}</p>`;
  }
  const today = dayKey(new Date(), tz);
  const sortedKeys = Array.from(grouped.keys()).sort((a, b) =>
    a.localeCompare(b)
  );
  return sortedKeys.map((k) => {
    const items = grouped.get(k)!;
    const isToday = k === today;
    const isPast = k < today;
    const itemsHtml = items.map((e) => {
      const time = formatTime(e.starts_at, tz, lang);
      const badge = e.source === "event" ? t.event : t.reminder;
      const meta: string[] = [];
      if (e.location) meta.push(escapeHtml(e.location));
      if (e.tags?.length) {
        meta.push(e.tags.map((tag) => "#" + escapeHtml(tag)).join(" "));
      }
      const metaHtml = meta.length > 0
        ? `<div class="meta">${meta.join(" · ")}</div>`
        : "";
      return `<li class="entry ${e.source}">
        <span class="time">${escapeHtml(time)}</span>
        <div class="body">
          <div class="title">${escapeHtml(e.title)} <span class="badge">${
        escapeHtml(badge)
      }</span></div>
          ${metaHtml}
        </div>
      </li>`;
    }).join("");
    return `<section class="day ${isToday ? "today" : ""} ${
      isPast ? "past" : ""
    }">
      <h2>${escapeHtml(formatLongDay(k, tz, lang))}${
      isToday ? ` <span class="todaytag">${escapeHtml(t.today)}</span>` : ""
    }</h2>
      <ul>${itemsHtml}</ul>
    </section>`;
  }).join("");
}

function renderMonth(
  grouped: Map<string, Entry[]>,
  tz: string,
  lang: string,
  t: Strings,
  monthOffset: number,
  token: string,
): string {
  const refToday = new Date();
  const today = dayKey(refToday, tz);
  const todayParts = today.split("-").map(Number);
  const baseYear = todayParts[0];
  const baseMonth = todayParts[1] - 1 + monthOffset;
  const targetYear = baseYear + Math.floor(baseMonth / 12);
  const targetMonth = ((baseMonth % 12) + 12) % 12;

  const monthLabel = new Intl.DateTimeFormat(localeFor(lang), {
    month: "long",
    year: "numeric",
    timeZone: tz,
  }).format(new Date(targetYear, targetMonth, 15));

  const firstOfMonth = new Date(targetYear, targetMonth, 1);
  const startWeekday = firstOfMonth.getDay();
  const startOffset = (startWeekday + 6) % 7;
  const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const cellsBefore = startOffset;
  const totalCells = Math.ceil((cellsBefore + daysInMonth) / 7) * 7;

  const weekdayLabels = (() => {
    const ref = new Date(2024, 0, 1);
    const out: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(ref);
      d.setDate(ref.getDate() + i);
      out.push(
        new Intl.DateTimeFormat(localeFor(lang), { weekday: "short" })
          .format(d),
      );
    }
    return out;
  })();

  let cells = "";
  for (let i = 0; i < totalCells; i++) {
    const dayNumber = i - cellsBefore + 1;
    if (dayNumber < 1 || dayNumber > daysInMonth) {
      cells += `<div class="cell empty"></div>`;
      continue;
    }
    const key = `${targetYear.toString().padStart(4, "0")}-${
      String(targetMonth + 1).padStart(2, "0")
    }-${String(dayNumber).padStart(2, "0")}`;
    const isToday = key === today;
    const items = grouped.get(key) ?? [];
    const itemsHtml = items.slice(0, 4).map((e) => {
      const time = formatTime(e.starts_at, tz, lang);
      return `<a class="dot ${e.source}" title="${
        escapeHtml(`${time} ${e.title}`)
      }">
        <span class="dot-time">${escapeHtml(time)}</span>
        <span class="dot-title">${escapeHtml(e.title)}</span>
      </a>`;
    }).join("");
    const overflow = items.length > 4
      ? `<div class="more">+${items.length - 4}</div>`
      : "";
    cells += `<div class="cell ${isToday ? "today" : ""}">
      <div class="num">${dayNumber}</div>
      ${itemsHtml}${overflow}
    </div>`;
  }

  const tokenParam = `t=${encodeURIComponent(token)}`;
  const prevHref = `?${tokenParam}&view=month&m=${monthOffset - 1}`;
  const nextHref = `?${tokenParam}&view=month&m=${monthOffset + 1}`;

  const head = `<div class="month-nav">
    <a class="navbtn" href="${prevHref}">‹ ${escapeHtml(t.prev)}</a>
    <h2>${escapeHtml(capitalise(monthLabel))}</h2>
    <a class="navbtn" href="${nextHref}">${escapeHtml(t.next)} ›</a>
  </div>`;

  const labels = weekdayLabels.map((d) =>
    `<div class="weekday">${escapeHtml(capitalise(d))}</div>`
  ).join("");

  return `${head}
    <div class="grid">
      <div class="weekdays">${labels}</div>
      <div class="days">${cells}</div>
    </div>`;
}

function capitalise(text: string): string {
  if (!text) return text;
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

function baseStyles(): string {
  return `<style>
:root {
  --bg: #fafafa; --fg: #18181b; --muted: #71717a;
  --line: #e4e4e7; --card: #ffffff;
  --accent: #4f46e5; --reminder: #d97706; --event: #0d9488;
  --past: #d4d4d8; --hover: #f4f4f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa;
    --line: #27272a; --card: #18181b;
    --past: #3f3f46; --hover: #1f1f23;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1rem 6rem;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  background: var(--bg); color: var(--fg);
}
.wrap { max-width: 960px; margin: 0 auto; }
header { margin-bottom: 1.25rem; }
h1 { margin: 0 0 .25rem; font-size: 1.6rem; letter-spacing: -.01em; }
.sub { margin: 0; color: var(--muted); font-size: .9rem; }
.tabs { display: flex; gap: .5rem; margin: 1rem 0 1.5rem; }
.tabs a {
  padding: .35rem .9rem; border-radius: 999px; text-decoration: none;
  color: var(--muted); border: 1px solid var(--line); font-size: .85rem;
}
.tabs a.active { color: var(--accent); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.month-nav {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: .75rem;
}
.month-nav h2 { margin: 0; font-size: 1.1rem; font-weight: 600; }
.navbtn {
  text-decoration: none; color: var(--muted); padding: .35rem .65rem;
  border-radius: .5rem; border: 1px solid transparent;
}
.navbtn:hover { background: var(--hover); border-color: var(--line); color: var(--fg); }
.grid { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.weekdays { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid var(--line); }
.weekday { padding: .55rem .75rem; font-size: .75rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.days { display: grid; grid-template-columns: repeat(7, 1fr); }
.cell { min-height: 96px; padding: .35rem .4rem; border-top: 1px solid var(--line); border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: .15rem; }
.cell:nth-child(7n+1) { border-left: 0; }
.cell.empty { background: transparent; }
.cell.today { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.cell .num { font-size: .8rem; color: var(--muted); align-self: flex-end; }
.cell.today .num { color: var(--accent); font-weight: 700; }
.dot { display: flex; gap: .25rem; align-items: baseline; padding: .1rem .3rem; border-radius: 4px; font-size: .72rem; line-height: 1.2; cursor: default; overflow: hidden; }
.dot.event { background: color-mix(in srgb, var(--event) 16%, transparent); color: var(--event); }
.dot.reminder { background: color-mix(in srgb, var(--reminder) 18%, transparent); color: var(--reminder); }
.dot-time { font-variant-numeric: tabular-nums; flex-shrink: 0; }
.dot-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.more { font-size: .7rem; color: var(--muted); padding: 0 .3rem; }
.day { margin-bottom: 1.5rem; }
.day h2 { font-size: .95rem; font-weight: 600; text-transform: capitalize; margin: 0 0 .6rem; padding-bottom: .35rem; border-bottom: 1px solid var(--line); }
.day.today h2 { color: var(--accent); border-color: var(--accent); }
.day.past { opacity: .55; }
.day .todaytag { font-size: .7rem; padding: .05rem .4rem; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; vertical-align: 2px; }
.day ul { list-style: none; padding: 0; margin: 0; }
.entry { display: flex; gap: 1rem; padding: .55rem 0; border-bottom: 1px dashed var(--line); }
.entry:last-child { border-bottom: 0; }
.entry .time { font-variant-numeric: tabular-nums; color: var(--muted); min-width: 4rem; padding-top: .1rem; }
.entry .title { font-weight: 500; }
.entry .meta { color: var(--muted); font-size: .85rem; margin-top: .15rem; }
.badge { font-size: .68rem; padding: .1rem .4rem; border-radius: 999px; vertical-align: 1px; margin-left: .35rem; color: #fff; }
.entry.event .badge { background: var(--event); }
.entry.reminder .badge { background: var(--reminder); color: #1c1917; }
.empty { color: var(--muted); padding: 2rem; text-align: center; background: var(--card); border: 1px dashed var(--line); border-radius: 12px; }
footer { color: var(--muted); font-size: .8rem; margin-top: 2rem; }
footer a { color: var(--muted); }
@media (max-width: 640px) {
  body { padding: 1rem .5rem 4rem; }
  .cell { min-height: 70px; padding: .25rem; }
  .dot-title { display: none; }
}
</style>`;
}

function unauthorizedPage(language: string): string {
  const t = strings(language);
  return `<!doctype html><meta charset="utf-8"><title>401</title>
<style>body{font:16px system-ui;margin:5rem;text-align:center;color:#333}</style>
<h1>${escapeHtml(t.unauthorized_title)}</h1>
<p>${escapeHtml(t.unauthorized_body)}</p>`;
}

function errorPage(msg: string, language: string): string {
  const t = strings(language);
  return `<!doctype html><meta charset="utf-8"><title>500</title>
<style>body{font:16px system-ui;margin:5rem;text-align:center;color:#333}</style>
<h1>${escapeHtml(t.error_title)}</h1>
<p>${escapeHtml(msg)}</p>`;
}
