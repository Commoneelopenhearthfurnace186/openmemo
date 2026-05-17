CREATE TABLE IF NOT EXISTS feedback_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id   uuid REFERENCES reminder(id) ON DELETE SET NULL,
  event_type    text NOT NULL CHECK (event_type IN (
    'acknowledged', 'snoozed', 'ignored', 'cancelled', 'nudged'
  )),
  hour_of_day   integer NOT NULL,  -- 0-23, when the event happened (owner tz)
  day_of_week   integer NOT NULL,  -- 0=Sunday, 6=Saturday
  response_time_seconds integer,   -- how long it took to respond (NULL if ignored)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_event_reminder_idx ON feedback_event (reminder_id);
CREATE INDEX IF NOT EXISTS feedback_event_type_idx ON feedback_event (event_type, hour_of_day);

ALTER TABLE feedback_event ENABLE ROW LEVEL SECURITY;
