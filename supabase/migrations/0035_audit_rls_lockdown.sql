REVOKE ALL ON FUNCTION public.audit_rls() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_rls() FROM anon;
REVOKE ALL ON FUNCTION public.audit_rls() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.audit_rls() TO service_role;
