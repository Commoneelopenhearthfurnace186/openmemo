# Changelog

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
