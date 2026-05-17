/**
 * OpenMemo â€” Property test P4.
 *
 * Property (design.md Â§ "Propiedades de correcciÃ³n", item 4):
 *   "Para todo recordatorio recurrente, tras cada disparo, el nuevo
 *    `next_trigger_at` es > occurrence_at del disparo previo."
 *
 * Requirement 4.5 specifies that after firing a recurring reminder the
 * scheduler must compute the next occurrence strictly in the future of
 * the previous one. This module verifies that invariant holds for both
 * `kind="recurring"` (RRULE-driven) and `kind="escalation"` with
 * `policy="repeat_after_delay"` reminders.
 *
 * Strategy:
 *   - Generate sane, common RRULEs the NLP_Engine is expected to emit.
 *   - Generate dtstart instants and IANA timezones (with DST).
 *   - Iterate `computeNextTrigger` N times and assert each output is
 *     strictly greater than the previous "after" instant.
 */

import * as fc from "fast-check";
import { computeNextTrigger } from "../supabase/functions/_shared/rrule.ts";

// Common, sane RRULEs the model is expected to emit.
const arbRRule = fc.constantFrom(
  "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  "FREQ=DAILY;BYHOUR=20;BYMINUTE=30",
  "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH;BYHOUR=7;BYMINUTE=0",
  "FREQ=WEEKLY;BYDAY=MO;BYHOUR=19;BYMINUTE=30",
  "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=3;BYHOUR=17;BYMINUTE=45",
  "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=9;BYMINUTE=0",
  "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=8;BYMINUTE=0",
  "FREQ=HOURLY;INTERVAL=2",
  "FREQ=HOURLY;INTERVAL=3",
);

const arbStart = fc.date({
  min: new Date(Date.UTC(2024, 0, 1)),
  max: new Date(Date.UTC(2026, 11, 31)),
}).map((d) => {
  const x = new Date(d);
  x.setUTCSeconds(0, 0);
  return x;
});

const arbTimezone = fc.constantFrom(
  "Europe/Madrid",
  "America/Mexico_City",
  "America/New_York",
  "UTC",
);

Deno.test("P4: recurring next_trigger_at is strictly monotonically increasing across firings", () => {
  fc.assert(
    fc.property(arbRRule, arbStart, arbTimezone, (rrule, start, tz) => {
      const reminder = {
        kind: "recurring" as const,
        next_trigger_at: start.toISOString(),
        recurrence_rule: rrule,
        re_evaluation_rule: null,
        escalation_rule: null,
        attempt_count: 0,
        timezone: tz,
        start_at: start.toISOString(),
      };

      let after = start;
      for (let i = 0; i < 10; i++) {
        const next = computeNextTrigger(reminder, after);
        if (next === null) return true;
        if (next.getTime() <= after.getTime()) {
          return false; // strict monotonicity violated
        }
        after = next;
      }
      return true;
    }),
    { numRuns: 100 },
  );
});

// Same property for escalation reminders with repeat_after_delay.
Deno.test("P4: escalation repeat_after_delay produces strictly increasing triggers", () => {
  fc.assert(
    fc.property(
      arbStart,
      fc.integer({ min: 1, max: 240 }),
      arbTimezone,
      (start, intervalMin, tz) => {
        const reminder = {
          kind: "escalation" as const,
          next_trigger_at: start.toISOString(),
          recurrence_rule: null,
          re_evaluation_rule: null,
          escalation_rule: {
            policy: "repeat_after_delay" as const,
            interval_minutes: intervalMin,
          },
          attempt_count: 0,
          timezone: tz,
          start_at: start.toISOString(),
        };

        let after = start;
        for (let i = 0; i < 5; i++) {
          const next = computeNextTrigger(reminder, after);
          if (next === null) return true;
          if (next.getTime() <= after.getTime()) return false;
          after = next;
        }
        return true;
      },
    ),
    { numRuns: 100 },
  );
});
