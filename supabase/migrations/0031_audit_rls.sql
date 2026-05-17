CREATE OR REPLACE FUNCTION public.audit_rls()
RETURNS TABLE (tablename text, rowsecurity boolean, policy_count integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.tablename::text,
    t.rowsecurity,
    COALESCE((SELECT count(*)::integer FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = t.tablename), 0)
  FROM pg_tables t
  WHERE t.schemaname = 'public'
  ORDER BY t.tablename;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_rls() FROM anon;
GRANT EXECUTE ON FUNCTION public.audit_rls() TO service_role;
