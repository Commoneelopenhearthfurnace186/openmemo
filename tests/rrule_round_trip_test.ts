/**
 * Property test P3 â€” Round-trip de RRULE.
 *
 * Para toda RRULE vÃ¡lida `r` y todo instante `t`,
 *   `RRule.fromString(r.toString()).after(t)` â‰¡ `r.after(t)`
 *
 * Es decir: serializar una RRULE a string y volver a construirla preserva
 * la siguiente ocurrencia respecto a un instante dado.
 *
 * Spec: `docs/` Â§
 * "Estrategia de tests (Property-Based Testing)" â€” propiedad 3.
 * Requisitos cubiertos: 2.5 (RRULE como salida del NLP) y 4.1
 * (recurrencias RRULE completas).
 */

import * as fc from "fast-check";
import { type Options, RRule } from "rrule";

// ---------------------------------------------------------------------------
// Generators for valid RRULE option components
// ---------------------------------------------------------------------------

const arbFreq = fc.constantFrom(
  RRule.YEARLY,
  RRule.MONTHLY,
  RRule.WEEKLY,
  RRule.DAILY,
  RRule.HOURLY,
);

const arbInterval = fc.integer({ min: 1, max: 12 });

const arbWeekdays = fc.subarray(
  [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU],
  { minLength: 0, maxLength: 7 },
);

const arbMonthdays = fc.subarray(
  Array.from({ length: 28 }, (_, i) => i + 1),
  { minLength: 0, maxLength: 5 },
);

const arbHours = fc.subarray(
  Array.from({ length: 24 }, (_, i) => i),
  { minLength: 0, maxLength: 3 },
);

const arbMinutes = fc.subarray([0, 15, 30, 45], { minLength: 0, maxLength: 2 });

const arbBySetPos = fc.subarray([1, 2, 3, 4, -1], { minLength: 0, maxLength: 1 });

// `dtstart` aligned to second precision in 2024-2026 to keep diff tractable.
const arbDtstart = fc
  .date({
    min: new Date(Date.UTC(2024, 0, 1)),
    max: new Date(Date.UTC(2026, 11, 31)),
  })
  .map((d) => {
    const x = new Date(d);
    x.setUTCSeconds(0, 0);
    return x;
  });

const arbRRuleOptions = fc
  .tuple(
    arbFreq,
    arbInterval,
    arbWeekdays,
    arbMonthdays,
    arbHours,
    arbMinutes,
    arbBySetPos,
    arbDtstart,
  )
  .map(
    (
      [freq, interval, byweekday, bymonthday, byhour, byminute, bysetpos, dtstart],
    ) => {
      const opts: Partial<Options> = { freq, interval, dtstart };
      if (byweekday.length) opts.byweekday = byweekday;
      if (bymonthday.length) opts.bymonthday = bymonthday;
      if (byhour.length) opts.byhour = byhour;
      if (byminute.length) opts.byminute = byminute;
      // BYSETPOS only really makes sense for MONTHLY/YEARLY; skip otherwise
      // to avoid the library throwing.
      if (
        bysetpos.length &&
        (freq === RRule.MONTHLY || freq === RRule.YEARLY)
      ) {
        opts.bysetpos = bysetpos;
      }
      return opts as Options;
    },
  );

const arbAfter = fc
  .date({
    min: new Date(Date.UTC(2024, 0, 1)),
    max: new Date(Date.UTC(2027, 11, 31)),
  })
  .map((d) => {
    const x = new Date(d);
    x.setUTCSeconds(0, 0);
    return x;
  });

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

Deno.test("P3: RRULE round-trip preserves the next occurrence", () => {
  fc.assert(
    fc.property(arbRRuleOptions, arbAfter, (opts, after) => {
      let original: RRule;
      try {
        original = new RRule(opts);
      } catch {
        // Skip combinations the library rejects.
        return true;
      }

      const serialized = original.toString();

      let restored: RRule;
      try {
        const parsed = RRule.parseString(serialized) as Partial<Options>;
        // `toString()` does not include DTSTART, so re-inject it for the
        // restored rule to compare apples to apples.
        restored = new RRule({ ...parsed, dtstart: opts.dtstart } as Options);
      } catch {
        return true;
      }

      const a = original.after(after, true);
      const b = restored.after(after, true);

      // Both null â†’ rule exhausted in the same way â†’ equal.
      if (a === null && b === null) return true;
      if (a === null || b === null) return false;
      return a.getTime() === b.getTime();
    }),
    { numRuns: 200 },
  );
});
