DROP FUNCTION IF EXISTS public.calendar_feed(text);

CREATE OR REPLACE FUNCTION public.calendar_feed(t text)
RETURNS TABLE (
  entry_id text,
  source text,
  title text,
  starts_at timestamptz,
  ends_at timestamptz,
  location text,
  tags text[]
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
    ce.tags
  FROM calendar_entries ce
  WHERE ce.starts_at >= now() - interval '7 days'
    AND ce.starts_at <= now() + interval '365 days'
  ORDER BY ce.starts_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calendar_feed(text) TO anon, authenticated;
