# Architecture

```
Telegram --webhook-->  Edge Function: telegram-webhook
                        |
                        +-->  LLM (chat + embeddings)
                        +-->  Postgres (reminders, events, notes,
                        |     tasks, lists, friends, journal,
                        |     habits, memory)
                        +-->  Storage (private files bucket)
                        +-->  Weather, news, web search APIs
                                   |
                pg_cron --1 min-->  Edge Function: dispatch-reminder
                                   |
                                   +-->  Telegram (delivery)

                pg_cron --2 h-->    Edge Function: pulse
                                   |
                                   +-->  Proactive nudges to Telegram

                                Browser  -->  Edge Function: calendar
                                   |          (JSON RPC, token-gated)
                                   +-->  Cloudflare Pages (static UI)
```

## Project layout

```
.
├── .env.example
├── deno.json
├── docs/                   architecture, operating, providers, screenshots
├── scripts/setup.sh        installer
├── supabase/
│   ├── config.toml
│   ├── migrations/         30+ ordered SQL migrations
│   └── functions/
│       ├── _shared/        agent, db, llm, telegram, email, pulse,
│       │                   weather, news, websearch, journal, habits
│       ├── telegram-webhook/
│       ├── dispatch-reminder/
│       ├── calendar/       JSON RPC for the web UI
│       └── pulse/          proactive nudges
├── calendar-cloud/         static HTML for the calendar
└── tests/                  unit + e2e suites
```

## Why this stack

- **Supabase free tier** runs the database, the storage bucket, the
  Edge Functions, the cron, and pgvector. One service for everything.
- **Deno + TypeScript** is the runtime Supabase Edge Functions use.
  Single language across the whole bot.
- **DeepSeek** because it is cheap, multilingual, and has a starter
  credit. Anything OpenAI-compatible works.
- **Cloudflare Pages free tier** hosts the static calendar UI on a
  domain Cloudflare gives you. Supabase's own hosting can not serve
  HTML on the free plan.
- **Telegram** because it is the cleanest cross-device chat UI for
  one user.

## How the agent works

The webhook hands every message to a tool-use loop. The LLM sees the
message plus the user's context (timezone, lists, pending items,
stored memory) and decides which tools to call. Tools cover every
verb: `create_reminder`, `add_to_list`, `get_weather`,
`add_journal_entry`, `connect_dots`, etc. There is no rigid intent
classifier; the LLM picks the path.

The agent runs up to 6 iterations and 24 tool calls per turn. After
each tool, the result is fed back to the LLM until it decides to
reply. The reply gets sent to Telegram.

## Proactive nudges

Every two hours during the user's local 8-22 window, `pulse` runs
four detectors:

- **Collisions** — two or more items on the same calendar day.
- **Birthday windows** — 30, 14, 7, 1 day before a friend's
  birthday.
- **Stale habits** — overdue against their cadence.
- **Idle** — five days without messaging the bot.

Detected nudges are deduplicated by a stable `kind+key` and queued
in `proactive_nudge`. The next pulse call (`?send=1`) ships the most
relevant one to Telegram.
