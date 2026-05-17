CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotency: if the tick already exists, drop it before re-creating.
-- Wrapped in DO $$ ... $$ so the unschedule failure (job not found) does
-- not abort the migration.
DO $$
BEGIN
  PERFORM cron.unschedule('OpenMemo-tick');
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END $$;

SELECT cron.schedule(
  'OpenMemo-tick',
  '* * * * *',
  $cron$
    SELECT select_due_reminders();
    SELECT net.http_post(
      url     := current_setting('app.settings.dispatcher_url',    true),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $cron$
);
