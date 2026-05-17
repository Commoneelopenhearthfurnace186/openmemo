-- Unified read-only view that exposes events and active reminders as a
-- single calendar feed. Used by the self-hosted /calendar Edge Function.

CREATE OR REPLACE VIEW calendar_entries AS
SELECT
  e.id::text         AS id,
  'event'::text      AS source,
  e.title            AS title,
  e.starts_at        AS starts_at,
  e.ends_at          AS ends_at,
  e.location         AS location,
  e.description      AS description,
  e.tags             AS tags
FROM event e
UNION ALL
SELECT
  r.id::text         AS id,
  'reminder'::text   AS source,
  COALESCE(r.content, '(sin contenido)') AS title,
  r.next_trigger_at  AS starts_at,
  NULL::timestamptz  AS ends_at,
  NULL::text         AS location,
  NULL::text         AS description,
  ARRAY[]::text[]    AS tags
FROM reminder r
WHERE r.status IN ('scheduled', 'active')
  AND r.next_trigger_at IS NOT NULL;

-- Single-row token table that the Edge Function checks before serving.
-- Insert a random ~32-char value after deploying. Anyone with this token
-- can read the agenda, so treat it like a password.
CREATE TABLE IF NOT EXISTS calendar_access (
  id    integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  token text NOT NULL
);
ALTER TABLE calendar_access ENABLE ROW LEVEL SECURITY;
