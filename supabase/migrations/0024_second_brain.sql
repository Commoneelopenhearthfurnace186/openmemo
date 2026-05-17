CREATE TABLE IF NOT EXISTS journal_entry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body        text NOT NULL,
  mood        text,
  tags        text[] NOT NULL DEFAULT '{}',
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
ALTER TABLE journal_entry ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS journal_entry_created_idx ON journal_entry (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS journal_entry_tags_idx ON journal_entry USING gin (tags);
CREATE INDEX IF NOT EXISTS journal_entry_emb_idx ON journal_entry USING hnsw (embedding vector_cosine_ops) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS proactive_nudge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  reason        text NOT NULL,
  ready_at      timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '48 hours',
  delivered_at  timestamptz,
  dismissed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE proactive_nudge ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS proactive_nudge_ready_idx ON proactive_nudge (ready_at) WHERE delivered_at IS NULL AND dismissed_at IS NULL;

CREATE TABLE IF NOT EXISTS habit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  cadence_days integer NOT NULL DEFAULT 1,
  last_done_at timestamptz,
  streak_count integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE habit ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS habit_log (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id  uuid NOT NULL REFERENCES habit(id) ON DELETE CASCADE,
  done_at   timestamptz NOT NULL DEFAULT now(),
  note      text
);
ALTER TABLE habit_log ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS habit_log_habit_idx ON habit_log (habit_id, done_at DESC);

CREATE OR REPLACE VIEW upcoming_collisions AS
WITH agenda AS (
  SELECT id::text AS id, content AS title, next_trigger_at AS at, 'reminder' AS source
  FROM reminder
  WHERE status IN ('scheduled','active','paused') AND next_trigger_at IS NOT NULL
  UNION ALL
  SELECT id::text, title, starts_at, 'event'
  FROM event
  WHERE starts_at IS NOT NULL
)
SELECT
  date_trunc('day', a.at AT TIME ZONE COALESCE((SELECT timezone FROM owner WHERE id = 1), 'UTC')) AS day,
  array_agg(jsonb_build_object('id', a.id, 'title', a.title, 'at', a.at, 'source', a.source) ORDER BY a.at) AS items
FROM agenda a
WHERE a.at >= now() - interval '1 day' AND a.at <= now() + interval '90 days'
GROUP BY 1
HAVING count(*) >= 2
ORDER BY 1;

CREATE OR REPLACE VIEW upcoming_birthdays AS
SELECT
  f.id,
  f.name,
  f.birthday,
  CASE
    WHEN make_date(extract(year FROM now())::int,
                   extract(month FROM f.birthday)::int,
                   extract(day FROM f.birthday)::int) >= current_date
      THEN make_date(extract(year FROM now())::int,
                     extract(month FROM f.birthday)::int,
                     extract(day FROM f.birthday)::int)
    ELSE make_date((extract(year FROM now())::int) + 1,
                   extract(month FROM f.birthday)::int,
                   extract(day FROM f.birthday)::int)
  END AS next_birthday
FROM friend f
WHERE f.birthday IS NOT NULL
ORDER BY 4;
