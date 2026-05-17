INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('trunk', 'trunk', false, 52428800)  -- 50 MB per file
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: deny all from anon/authenticated. Service role bypasses RLS by
-- default. We ensure no public policies exist for the bucket. The default
-- "bucket owner" policy in Supabase requires authenticated users; with no
-- permissive policies in place, only service_role (server-side from Edge
-- Functions) can read or write objects under the `trunk` bucket.
