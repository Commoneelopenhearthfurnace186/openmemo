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
        url     := (SELECT pulse_url FROM pulse_config WHERE id = 1) || '?send=1',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (SELECT service_role_key FROM pulse_config WHERE id = 1)
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 30000
      )::text
    END;
  $cron$
);
