const OPENWEATHER_KEY = Deno.env.get("OPENWEATHER_API_KEY") ?? "";

export interface WeatherSnapshot {
  city: string;
  country: string;
  temp: number;
  feels_like: number;
  units: "metric" | "imperial";
  description: string;
  wind: number;
  wind_unit: "km/h" | "mph";
  humidity: number;
  precip_chance: number | null;
  forecast_today: string;
}

export async function getWeather(
  lat: number,
  lon: number,
  units: "metric" | "imperial" = "metric",
  lang: string = "en",
): Promise<WeatherSnapshot | { error: string }> {
  if (!OPENWEATHER_KEY) return { error: "OPENWEATHER_API_KEY not set" };

  const params = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    appid: OPENWEATHER_KEY,
    units,
    lang,
  });
  const currentUrl =
    `https://api.openweathermap.org/data/2.5/weather?${params.toString()}`;
  const forecastUrl =
    `https://api.openweathermap.org/data/2.5/forecast?${params.toString()}&cnt=8`;

  try {
    const [curRes, fcRes] = await Promise.all([
      fetch(currentUrl),
      fetch(forecastUrl),
    ]);
    if (!curRes.ok) {
      const detail = await curRes.text().catch(() => "");
      return {
        error:
          `weather provider HTTP ${curRes.status}${
            detail ? `: ${detail.slice(0, 200)}` : ""
          }`,
      };
    }
    const cur = await curRes.json();
    const fc = fcRes.ok ? await fcRes.json() : null;

    const description = cur.weather?.[0]?.description ?? "";
    const rawWind = cur.wind?.speed ?? 0;
    const wind = units === "metric" ? rawWind * 3.6 : rawWind;
    const list = (fc?.list ?? []) as Array<
      { dt_txt: string; pop?: number; weather?: Array<{ description: string }> }
    >;
    const todayDescriptions = list
      .slice(0, 6)
      .map((s) => s.weather?.[0]?.description ?? "")
      .filter((d) => d.length > 0);
    const maxPop = list.slice(0, 6).reduce(
      (m, s) => Math.max(m, s.pop ?? 0),
      0,
    );

    return {
      city: cur.name ?? "",
      country: cur.sys?.country ?? "",
      temp: Math.round(cur.main?.temp ?? 0),
      feels_like: Math.round(cur.main?.feels_like ?? cur.main?.temp ?? 0),
      units,
      description,
      wind: Math.round(wind),
      wind_unit: units === "metric" ? "km/h" : "mph",
      humidity: cur.main?.humidity ?? 0,
      precip_chance: maxPop > 0 ? Math.round(maxPop * 100) : null,
      forecast_today: dedupe(todayDescriptions).slice(0, 3).join(", "),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export async function geocode(
  query: string,
): Promise<{ lat: number; lon: number; name: string; country: string } | null> {
  if (!OPENWEATHER_KEY) return null;
  const params = new URLSearchParams({
    q: query,
    limit: "1",
    appid: OPENWEATHER_KEY,
  });
  const url =
    `https://api.openweathermap.org/geo/1.0/direct?${params.toString()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.json();
    const first = arr?.[0];
    if (!first) return null;
    return {
      lat: first.lat,
      lon: first.lon,
      name: first.name,
      country: first.country ?? "",
    };
  } catch {
    return null;
  }
}
