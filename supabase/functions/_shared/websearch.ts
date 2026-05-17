const TAVILY_KEY = Deno.env.get("TAVILY_API_KEY") ?? "";
const BRAVE_KEY = Deno.env.get("BRAVE_SEARCH_API_KEY") ?? "";
const SERPAPI_KEY = Deno.env.get("SERPAPI_API_KEY") ?? "";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(
  query: string,
  limit: number = 5,
): Promise<SearchHit[] | { error: string }> {
  if (TAVILY_KEY) return tavily(query, limit);
  if (BRAVE_KEY) return brave(query, limit);
  if (SERPAPI_KEY) return serpapi(query, limit);
  return {
    error:
      "no search provider configured (TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, or SERPAPI_API_KEY)",
  };
}

async function tavily(
  query: string,
  limit: number,
): Promise<SearchHit[] | { error: string }> {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        max_results: Math.min(10, Math.max(1, limit)),
        search_depth: "basic",
      }),
    });
    if (!res.ok) return { error: `tavily HTTP ${res.status}` };
    const data = await res.json();
    const items = (data.results ?? []) as Array<Record<string, unknown>>;
    return items.slice(0, limit).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.content ?? "").slice(0, 280),
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function brave(
  query: string,
  limit: number,
): Promise<SearchHit[] | { error: string }> {
  const params = new URLSearchParams({ q: query, count: String(limit) });
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      { headers: { "X-Subscription-Token": BRAVE_KEY, "Accept": "application/json" } },
    );
    if (!res.ok) return { error: `brave HTTP ${res.status}` };
    const data = await res.json();
    const items =
      (data.web?.results ?? []) as Array<Record<string, unknown>>;
    return items.slice(0, limit).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.description ?? "").slice(0, 280),
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function serpapi(
  query: string,
  limit: number,
): Promise<SearchHit[] | { error: string }> {
  const params = new URLSearchParams({
    q: query,
    api_key: SERPAPI_KEY,
    num: String(limit),
  });
  try {
    const res = await fetch(
      `https://serpapi.com/search.json?${params.toString()}`,
    );
    if (!res.ok) return { error: `serpapi HTTP ${res.status}` };
    const data = await res.json();
    const items =
      (data.organic_results ?? []) as Array<Record<string, unknown>>;
    return items.slice(0, limit).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.snippet ?? "").slice(0, 280),
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
