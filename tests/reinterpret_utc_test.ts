/**
 * OpenMemo - reinterpretUtcAsLocal unit test.
 *
 * Guards the timezone bug fix: when the LLM emits an ISO with Z or +00:00
 * but the user is not in UTC, the wall-clock the user said was almost
 * certainly local. The helper rewrites the suffix to the owner's IANA
 * offset, including DST, while leaving UTC owners and well-formed ISOs
 * untouched.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { reinterpretUtcAsLocal } from "../supabase/functions/_shared/tz.ts";

interface Case {
  name: string;
  input: string;
  tz: string;
  expected: string;
}

const cases: Case[] = [
  { name: "UTC noop Z", input: "2026-05-17T04:00:00Z", tz: "UTC", expected: "2026-05-17T04:00:00Z" },
  { name: "Etc/UTC noop Z", input: "2026-05-17T04:00:00Z", tz: "Etc/UTC", expected: "2026-05-17T04:00:00Z" },
  { name: "Santiago already -04:00 noop", input: "2026-05-17T20:00:00-04:00", tz: "America/Santiago", expected: "2026-05-17T20:00:00-04:00" },
  { name: "Madrid already +02:00 noop", input: "2026-05-17T20:00:00+02:00", tz: "Europe/Madrid", expected: "2026-05-17T20:00:00+02:00" },
  { name: "Santiago Z winter", input: "2026-05-17T20:00:00Z", tz: "America/Santiago", expected: "2026-05-17T20:00:00-04:00" },
  { name: "Madrid Z summer DST", input: "2026-07-15T09:00:00Z", tz: "Europe/Madrid", expected: "2026-07-15T09:00:00+02:00" },
  { name: "Madrid Z winter standard", input: "2026-01-15T09:00:00Z", tz: "Europe/Madrid", expected: "2026-01-15T09:00:00+01:00" },
  { name: "Tokyo Z March", input: "2026-03-01T08:00:00Z", tz: "Asia/Tokyo", expected: "2026-03-01T08:00:00+09:00" },
  { name: "Tokyo Z August", input: "2026-08-01T08:00:00Z", tz: "Asia/Tokyo", expected: "2026-08-01T08:00:00+09:00" },
  { name: "+00:00 suffix treated as Z", input: "2026-05-17T20:00:00+00:00", tz: "America/Santiago", expected: "2026-05-17T20:00:00-04:00" },
  { name: "-00:00 suffix treated as Z", input: "2026-05-17T20:00:00-00:00", tz: "America/Santiago", expected: "2026-05-17T20:00:00-04:00" },
  { name: "sub-second precision preserved", input: "2026-05-17T20:00:00.123Z", tz: "America/Santiago", expected: "2026-05-17T20:00:00.123-04:00" },
  { name: "malformed string passthrough", input: "not a date", tz: "America/Santiago", expected: "not a date" },
  { name: "date-only passthrough", input: "2026-05-17", tz: "America/Santiago", expected: "2026-05-17" },
];

Deno.test("reinterpretUtcAsLocal cases", () => {
  for (const c of cases) {
    assertEquals(reinterpretUtcAsLocal(c.input, c.tz), c.expected, c.name);
  }
});
