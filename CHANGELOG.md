# Changelog

## 0.2.1

### Fixed

- **Timezone: guaranteed correct wall-clock storage.** The LLM can
  emit ISO timestamps with any offset (Z, +00:00, -05:00, naive
  without offset). The system now strips whatever offset the model
  attached and re-stamps the wall-clock with the real IANA offset
  for that date, computed via `formatInTimeZone`. This makes it
  impossible for the LLM to cause a wrong firing time. The guard
  (`forceLocalOffset` in `supabase/functions/_shared/tz.ts`) is
  applied at every entry point: `exec_create_reminder`,
  `exec_update_reminder`, `exec_create_event` (agent tool path),
  plus every `parseIso` call in `handlers/reminders.ts` (static,
  recurring, dynamic, conditional, escalation, composite children,
  update) and `handlers/calendar.ts` (create, query with explicit
  date). Zero unguarded paths remain.
- Removed auto-created "Buenos dias" daily briefing seed
  (migration 0010 inserted a hardcoded 08:00 UTC reminder for all
  users regardless of timezone). Users who want a daily briefing
  must ask for it explicitly.
- The bot responded to "what time is it on your internal clock"
  with a fabricated UTC time. Tool description and prompt rules now
  state the assistant has no separate clock: it reads the user's
  clock through `current_time`.
- Appointments with a person or place now require both
  `create_reminder` and `create_event`.
- "Morning" / "noche" wording reads `wake_time` / `bed_time` from
  `owner_context`. If missing, asks once and persists.
- Confirmation is one-shot. After "yes" the agent executes.
- The agent never creates reminders the user did not ask for
  (rule 15).
- Before any greeting, the agent calls `current_time` and picks
  the correct salutation for the local hour (rule 16).

### Added

- `supabase/functions/_shared/tz.ts` with `reinterpretUtcAsLocal`,
  isolated from runtime env so it can be unit-tested.
- `tests/reinterpret_utc_test.ts` covering UTC noop, Santiago,
  Madrid summer + winter (DST), Tokyo year-round, `+00:00` and
  `-00:00` suffixes, sub-second precision, malformed ISO. 8 tests,
  all green.

### Changed

- Removed unused imports and dead helpers in
  `supabase/functions/_shared/agent.ts`,
  `supabase/functions/_shared/commands.ts` and
  `supabase/functions/telegram-webhook/index.ts` flagged by the
  linter (CodeRabbit / Sonar).
- Replaced `String#replace(/x/g, …)` with `String#replaceAll` in
  `agent.ts` and `calendar/index.ts`. Replaced `parseInt` with
  `Number.parseInt` in `dispatch-reminder/index.ts`. Replaced
  `String#charCodeAt` with `String#codePointAt` in `telegram.ts`.
- `calendar/index.ts` `Array#sort()` on date keys now uses
  `localeCompare` so order is locale-stable.
- `calendar-cloud/index.html` settings modal: every `<label>` now
  has a `for=` attribute pointing at its control.

### Repository

- `sonar-project.properties` excludes `supabase/migrations/**` and
  `tests/**` from duplication scoring (forward-only migrations and
  shared test fixtures are not real duplication).

## 0.2.0

- Added daily proactive nudges via the `pulse` Edge Function and a
  pg_cron tick: collisions in the agenda, upcoming birthdays, dropped
  habits, idle stretches.
- Added second-brain features: journal entries with semantic search,
  habit tracking with streaks, agenda collision detection.
- Added weather (OpenWeather), good-news headlines (GNews/NewsAPI),
  live web search (Tavily/Brave/SerpAPI), location geocoding.
- Added the JSON RPC `calendar_feed` and `calendar_meta` to power a
  static HTML calendar UI shipped under `calendar-cloud/`. Month,
  week, day and list views, color picker, week start day, default
  view, language-aware.
- One-shot installer at `scripts/setup.sh` that links the project,
  applies migrations, pushes secrets, deploys every function, sets
  the cron URLs, and registers the Telegram webhook.
- Default language is now English. Switch with
  `UPDATE owner SET language = 'es' WHERE id = 1;`.
- No timezone fallback: the bot asks for it on first message and
  derives the IANA zone from your reported time.
- Mojibake repair pass on source strings.
- Atomic habit logging via `log_habit_atomic` (no race conditions on
  streak updates).
- Birthday view now safe across leap years and the owner timezone.

## 0.1.0

- Initial release.
