CREATE TABLE IF NOT EXISTS calendar_pref (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  reminder_color  text NOT NULL DEFAULT '#d97706',
  event_color     text NOT NULL DEFAULT '#0d9488',
  birthday_color  text NOT NULL DEFAULT '#ec4899',
  accent_color    text NOT NULL DEFAULT '#4f46e5',
  week_starts_on  smallint NOT NULL DEFAULT 1 CHECK (week_starts_on BETWEEN 0 AND 6),
  default_view    text NOT NULL DEFAULT 'month' CHECK (default_view IN ('month','week','list','day')),
  show_completed  boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE calendar_pref ENABLE ROW LEVEL SECURITY;

INSERT INTO calendar_pref (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE event ADD COLUMN IF NOT EXISTS color text;

CREATE OR REPLACE VIEW calendar_entries AS
SELECT
  e.id::text         AS id,
  'event'::text      AS source,
  e.title            AS title,
  e.starts_at        AS starts_at,
  e.ends_at          AS ends_at,
  e.location         AS location,
  e.description      AS description,
  COALESCE(e.tags, '{}')::text[] AS tags,
  e.color            AS color
FROM event e
UNION ALL
SELECT
  r.id::text                            AS id,
  'reminder'::text                      AS source,
  COALESCE(r.content, '(sin contenido)') AS title,
  r.next_trigger_at                     AS starts_at,
  NULL::timestamptz                     AS ends_at,
  NULL::text                            AS location,
  NULL::text                            AS description,
  ARRAY[]::text[]                       AS tags,
  NULL::text                            AS color
FROM reminder r
WHERE r.status IN ('scheduled', 'active')
  AND r.next_trigger_at IS NOT NULL;

DROP FUNCTION IF EXISTS public.calendar_feed(text);

CREATE OR REPLACE FUNCTION public.calendar_feed(t text)
RETURNS TABLE (
  entry_id text,
  source text,
  title text,
  starts_at timestamptz,
  ends_at timestamptz,
  location text,
  description text,
  tags text[],
  color text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  expected text;
BEGIN
  SELECT token INTO expected FROM calendar_access WHERE id = 1;
  IF expected IS NULL OR t IS NULL OR t <> expected THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    ce.id,
    ce.source,
    ce.title,
    ce.starts_at,
    ce.ends_at,
    ce.location,
    ce.description,
    ce.tags,
    ce.color
  FROM calendar_entries ce
  WHERE ce.starts_at >= now() - interval '90 days'
    AND ce.starts_at <= now() + interval '730 days'
  ORDER BY ce.starts_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calendar_feed(text) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.calendar_owner(text);

CREATE OR REPLACE FUNCTION public.calendar_meta(t text)
RETURNS TABLE (
  timezone text,
  language text,
  display_name text,
  reminder_color text,
  event_color text,
  birthday_color text,
  accent_color text,
  week_starts_on smallint,
  default_view text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  expected text;
BEGIN
  SELECT token INTO expected FROM calendar_access WHERE id = 1;
  IF expected IS NULL OR t IS NULL OR t <> expected THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.timezone, o.language, o.display_name,
    p.reminder_color, p.event_color, p.birthday_color,
    p.accent_color, p.week_starts_on, p.default_view
  FROM owner o
  LEFT JOIN calendar_pref p ON p.id = 1
  WHERE o.id = 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calendar_meta(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.calendar_set_pref(
  t text,
  reminder_color text DEFAULT NULL,
  event_color text DEFAULT NULL,
  birthday_color text DEFAULT NULL,
  accent_color text DEFAULT NULL,
  week_starts_on smallint DEFAULT NULL,
  default_view text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  expected text;
BEGIN
  SELECT token INTO expected FROM calendar_access WHERE id = 1;
  IF expected IS NULL OR t IS NULL OR t <> expected THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  UPDATE calendar_pref SET
    reminder_color = COALESCE(calendar_set_pref.reminder_color, calendar_pref.reminder_color),
    event_color    = COALESCE(calendar_set_pref.event_color, calendar_pref.event_color),
    birthday_color = COALESCE(calendar_set_pref.birthday_color, calendar_pref.birthday_color),
    accent_color   = COALESCE(calendar_set_pref.accent_color, calendar_pref.accent_color),
    week_starts_on = COALESCE(calendar_set_pref.week_starts_on, calendar_pref.week_starts_on),
    default_view   = COALESCE(calendar_set_pref.default_view, calendar_pref.default_view),
    updated_at     = now()
  WHERE id = 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calendar_set_pref(text, text, text, text, text, smallint, text) TO anon, authenticated;
