CREATE OR REPLACE FUNCTION public.match_journal(
  query_embedding vector(1536),
  match_count integer DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  body text,
  mood text,
  tags text[],
  created_at timestamptz,
  similarity real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    j.id,
    j.body,
    j.mood,
    j.tags,
    j.created_at,
    1 - (j.embedding <=> query_embedding) AS similarity
  FROM journal_entry j
  WHERE j.deleted_at IS NULL
    AND j.embedding IS NOT NULL
  ORDER BY j.embedding <=> query_embedding
  LIMIT match_count;
$$;

REVOKE EXECUTE ON FUNCTION public.match_journal(vector, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.match_journal(vector, integer) TO service_role;
