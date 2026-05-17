-- Move the dispatcher URL and bearer token used by pg_cron from a
-- hardcoded literal in 0008 into a private config table. New deploys
-- pick the table-based cron up directly via 0008; this migration
-- catches existing deploys that already ran the old 0008.

CREATE TABLE IF NOT EXISTS app_config (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  dispatcher_url text NOT NULL,
  service_role_key text NOT NULL
);
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  PERFORM cron.unschedule('OpenMemo-tick');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'OpenMemo-tick',
  '* * * * *',
  $cron$
    SELECT select_due_reminders();
    SELECT net.http_post(
      url     := (SELECT dispatcher_url FROM app_config WHERE id = 1),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT service_role_key FROM app_config WHERE id = 1)
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $cron$
);
