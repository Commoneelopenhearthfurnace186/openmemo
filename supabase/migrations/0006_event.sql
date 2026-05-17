CREATE TABLE IF NOT EXISTS event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  location    text,
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS event_starts_at_idx ON event (starts_at);
CREATE INDEX IF NOT EXISTS event_tags_idx ON event USING gin (tags);

ALTER TABLE event ENABLE ROW LEVEL SECURITY;
