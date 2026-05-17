-- Track every delivered reminder waiting for a "listo" / "hecho" reply.
CREATE TABLE IF NOT EXISTS pending_ack (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id     uuid NOT NULL REFERENCES reminder(id) ON DELETE CASCADE,
  delivered_at    timestamptz NOT NULL DEFAULT now(),
  next_nudge_at   timestamptz NOT NULL,           -- when to resend if no ack
  nudge_count     integer NOT NULL DEFAULT 0,
  max_nudges      integer NOT NULL DEFAULT 3,
  is_critical     boolean NOT NULL DEFAULT false,
  acknowledged_at timestamptz                     -- NULL = still waiting
);

CREATE INDEX IF NOT EXISTS pending_ack_pending_idx
  ON pending_ack (next_nudge_at)
  WHERE acknowledged_at IS NULL;

ALTER TABLE pending_ack ENABLE ROW LEVEL SECURITY;

-- Function for the cron tick to find acks that need a nudge.
CREATE OR REPLACE FUNCTION select_due_nudges()
RETURNS SETOF pending_ack
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT *
  FROM pending_ack
  WHERE acknowledged_at IS NULL
    AND next_nudge_at <= now()
    AND nudge_count < max_nudges;
$$;

REVOKE ALL ON FUNCTION select_due_nudges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION select_due_nudges() TO postgres;
