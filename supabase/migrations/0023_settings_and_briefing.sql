CREATE TABLE IF NOT EXISTS app_setting (
  key   text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_setting ENABLE ROW LEVEL SECURITY;

ALTER TABLE owner ADD COLUMN IF NOT EXISTS latitude  numeric;
ALTER TABLE owner ADD COLUMN IF NOT EXISTS longitude numeric;
ALTER TABLE owner ADD COLUMN IF NOT EXISTS city      text;
ALTER TABLE owner ADD COLUMN IF NOT EXISTS country   text;
ALTER TABLE owner ADD COLUMN IF NOT EXISTS briefing_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE owner ADD COLUMN IF NOT EXISTS briefing_time text NOT NULL DEFAULT '08:00';

INSERT INTO app_setting (key, value) VALUES
  ('default_language', 'en')
ON CONFLICT (key) DO NOTHING;
