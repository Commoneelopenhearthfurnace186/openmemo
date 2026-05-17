const NEWSAPI_KEY = Deno.env.get("NEWSAPI_API_KEY") ?? "";
const GNEWS_KEY = Deno.env.get("GNEWS_API_KEY") ?? "";

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  description: string;
  published_at: string;
}

const POSITIVE_TERMS = [
  "breakthrough",
  "discovery",
  "achievement",
  "rescued",
  "milestone",
  "record",
  "celebrate",
  "first ever",
  "approved",
  "launch",
  "wins",
  "success",
];

const NEGATIVE_TERMS = [
  "war",
  "killed",
  "dead",
  "shooting",
  "attack",
  "tragedy",
  "crisis",
  "scandal",
  "outrage",
  "fire",
  "crash",
];

export async function getGoodNews(
  topic: string = "world",
  language: string = "en",
  limit: number = 5,
): Promise<NewsItem[] | { error: string }> {
  if (GNEWS_KEY) return getFromGNews(topic, language, limit);
  if (NEWSAPI_KEY) return getFromNewsAPI(topic, language, limit);
  return { error: "NEWSAPI_API_KEY or GNEWS_API_KEY not set" };
}

async function getFromGNews(
  topic: string,
  language: string,
  limit: number,
): Promise<NewsItem[] | { error: string }> {
  const positives = POSITIVE_TERMS.slice(0, 4)
    .map((t) => `"${t}"`)
    .join(" OR ");
  const params = new URLSearchParams({
    q: `${topic} AND (${positives})`,
    lang: language,
    max: String(Math.min(10, Math.max(3, limit * 2))),
    sortby: "publishedAt",
    apikey: GNEWS_KEY,
  });
  const url = `https://gnews.io/api/v4/search?${params.toString()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `gnews HTTP ${res.status}` };
    const data = await res.json();
    const items = ((data.articles ?? []) as Array<Record<string, unknown>>)
      .map((a) => ({
        title: String(a.title ?? ""),
        source: String((a.source as { name?: string })?.name ?? ""),
        url: String(a.url ?? ""),
        description: String(a.description ?? ""),
        published_at: String(a.publishedAt ?? ""),
      }));
    return rank(items, limit);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function getFromNewsAPI(
  topic: string,
  language: string,
  limit: number,
): Promise<NewsItem[] | { error: string }> {
  const params = new URLSearchParams({
    q: `${topic} AND (${POSITIVE_TERMS.slice(0, 6).join(" OR ")})`,
    language,
    sortBy: "publishedAt",
    pageSize: String(Math.min(20, Math.max(5, limit * 3))),
  });
  const url = `https://newsapi.org/v2/everything?${params.toString()}`;
  try {
    const res = await fetch(url, {
      headers: { "X-Api-Key": NEWSAPI_KEY },
    });
    if (!res.ok) return { error: `newsapi HTTP ${res.status}` };
    const data = await res.json();
    const items = ((data.articles ?? []) as Array<Record<string, unknown>>)
      .map((a) => ({
        title: String(a.title ?? ""),
        source: String((a.source as { name?: string })?.name ?? ""),
        url: String(a.url ?? ""),
        description: String(a.description ?? ""),
        published_at: String(a.publishedAt ?? ""),
      }));
    return rank(items, limit);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function rank(items: NewsItem[], limit: number): NewsItem[] {
  const scored = items.map((it) => {
    const text = (it.title + " " + it.description).toLowerCase();
    let score = 0;
    for (const t of POSITIVE_TERMS) if (text.includes(t)) score += 2;
    for (const t of NEGATIVE_TERMS) if (text.includes(t)) score -= 3;
    return { it, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score >= 0).slice(0, limit).map((s) => s.it);
}
