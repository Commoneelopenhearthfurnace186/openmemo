import { formatInTimeZone } from "date-fns-tz";

/**
 * Strips any offset the LLM might have attached and re-stamps the wall-clock
 * with the owner's real IANA offset for that date. This makes it impossible
 * for the LLM to produce a wrong offset.
 *
 * Examples (owner in America/Santiago, UTC-4 winter):
 *   "2026-05-19T09:00:00Z"       -> "2026-05-19T09:00:00-04:00"
 *   "2026-05-19T09:00:00+00:00"  -> "2026-05-19T09:00:00-04:00"
 *   "2026-05-19T09:00:00-05:00"  -> "2026-05-19T09:00:00-04:00"
 *   "2026-05-19T09:00:00"        -> "2026-05-19T09:00:00-04:00"
 *   "2026-05-19T09:00:00-04:00"  -> "2026-05-19T09:00:00-04:00" (already correct)
 *
 * For UTC owners, the input passes through unchanged.
 */
export function forceLocalOffset(iso: string, timezone: string): string {
  if (timezone === "UTC" || timezone === "Etc/UTC") return iso;

  // Extract wall-clock portion (yyyy-MM-ddTHH:mm[:ss[.fff]])
  const m = iso.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/,
  );
  if (!m) return iso; // not a recognizable ISO, pass through

  const wall = m[1];
  // Compute the real offset for this wall-clock instant in the owner's zone.
  // We interpret `wall` as UTC momentarily just to seed formatInTimeZone,
  // which gives us the zone's offset for that calendar date.
  const offset = formatInTimeZone(new Date(`${wall}Z`), timezone, "xxx");
  return `${wall}${offset}`;
}

// Backwards-compatible alias used by tests
export const reinterpretUtcAsLocal = forceLocalOffset;
