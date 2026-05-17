CREATE TABLE IF NOT EXISTS pulse_config (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pulse_url       text NOT NULL,
  service_role_key text NOT NULL
);
ALTER TABLE pulse_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  PERFORM cron.unschedule('pulse-tick');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'pulse-tick',
  '5 */2 * * *',
  $cron$
    SELECT CASE
      WHEN extract(hour FROM (now() AT TIME ZONE COALESCE((SELECT timezone FROM owner WHERE id = 1), 'UTC'))) BETWEEN 8 AND 22
      THEN net.http_post(
        url     := (SELECT pulse_url FROM pulse_config WHERE id = 1),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (SELECT service_role_key FROM pulse_config WHERE id = 1)
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 30000,
        url_params := jsonb_build_object('send', '1')
      )::text
    END;
  $cron$
);
