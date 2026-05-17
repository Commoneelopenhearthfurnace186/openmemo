BEGIN;

-- -----------------------------------------------------------------------------
-- Assertion 1 (Req 1.5): owner singleton CHECK (id = 1) is enforced.
--   - Insert a first owner row with id = 1.
--   - Attempt to insert a second owner row with id = 2; it MUST fail because
--     of the table-level CHECK (id = 1) constraint.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  ok boolean := false;
BEGIN
  -- Seed the singleton row. We use a fake chat_id unlikely to collide with any
  -- real Telegram identifier and that fits inside bigint.
  INSERT INTO owner (id, chat_id, display_name)
  VALUES (1, -999999999001, 'test_owner_singleton');

  BEGIN
    INSERT INTO owner (id, chat_id, display_name)
    VALUES (2, -999999999002, 'test_owner_singleton_dup');
    -- If the INSERT above succeeds, the CHECK is broken.
    ok := false;
  EXCEPTION
    WHEN check_violation THEN
      ok := true;
  END;

  -- Cleanup regardless of outcome (the outer BEGIN/ROLLBACK is the safety net).
  DELETE FROM owner WHERE id IN (1, 2);

  IF NOT ok THEN
    RAISE EXCEPTION 'assertion 1 (owner singleton, Req 1.5) failed: expected check_violation on id <> 1';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Assertion 2 (Req 16.3): job_outbox.idempotency_key UNIQUE.
--   - Insert a fake reminder + a job_outbox row with idempotency_key
--     'test_key_1'.
--   - Attempt to insert a second job_outbox row with the same idempotency key;
--     it MUST fail with unique_violation.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  ok boolean := false;
  v_reminder_id uuid := '00000000-0000-0000-0000-0000000000a1';
BEGIN
  INSERT INTO reminder (id, kind, status, content, timezone, next_trigger_at)
  VALUES (
    v_reminder_id,
    'static',
    'scheduled',
    'test reminder for idempotency assertion',
    'UTC',
    now()
  );

  INSERT INTO job_outbox (reminder_id, occurrence_at, idempotency_key)
  VALUES (v_reminder_id, now(), 'test_key_1');

  BEGIN
    INSERT INTO job_outbox (reminder_id, occurrence_at, idempotency_key)
    VALUES (v_reminder_id, now(), 'test_key_1');
    ok := false;
  EXCEPTION
    WHEN unique_violation THEN
      ok := true;
  END;

  -- Cleanup. Deleting the reminder cascades to job_outbox via ON DELETE CASCADE.
  DELETE FROM reminder WHERE id = v_reminder_id;

  IF NOT ok THEN
    RAISE EXCEPTION 'assertion 2 (job_outbox.idempotency_key UNIQUE, Req 16.3) failed: expected unique_violation';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Assertion 3a (Req 3.1): kind = 'recurring' requires recurrence_rule NOT NULL.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO reminder (kind, status, content, timezone, recurrence_rule)
    VALUES ('recurring', 'active', 'test recurring missing rule', 'UTC', NULL);
    ok := false;
  EXCEPTION
    WHEN check_violation THEN
      ok := true;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'assertion 3a (kind=recurring requires recurrence_rule, Req 3.1) failed: expected check_violation';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Assertion 3b (Req 3.1): kind = 'dynamic' requires template_id NOT NULL.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO reminder (kind, status, content, timezone, template_id)
    VALUES ('dynamic', 'scheduled', 'test dynamic missing template', 'UTC', NULL);
    ok := false;
  EXCEPTION
    WHEN check_violation THEN
      ok := true;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'assertion 3b (kind=dynamic requires template_id, Req 3.1) failed: expected check_violation';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Assertion 3c (Req 3.1): kind = 'conditional' requires condition NOT NULL.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO reminder (kind, status, content, timezone, condition)
    VALUES ('conditional', 'scheduled', 'test conditional missing condition', 'UTC', NULL);
    ok := false;
  EXCEPTION
    WHEN check_violation THEN
      ok := true;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'assertion 3c (kind=conditional requires condition, Req 3.1) failed: expected check_violation';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Assertion 3d (Req 3.1): kind = 'escalation' requires escalation_rule NOT NULL.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO reminder (kind, status, content, timezone, escalation_rule)
    VALUES ('escalation', 'active', 'test escalation missing rule', 'UTC', NULL);
    ok := false;
  EXCEPTION
    WHEN check_violation THEN
      ok := true;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'assertion 3d (kind=escalation requires escalation_rule, Req 3.1) failed: expected check_violation';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Assertion 4 (Req 3.1): reminder.attempt_count <= 50 hard cap.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO reminder (kind, status, content, timezone, attempt_count)
    VALUES ('static', 'scheduled', 'test attempt_count cap', 'UTC', 51);
    ok := false;
  EXCEPTION
    WHEN check_violation THEN
      ok := true;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'assertion 4 (reminder.attempt_count <= 50) failed: expected check_violation';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Assertion 5 (Req 18.1): RLS is enabled on `owner`.
--   pg_class.relrowsecurity must be TRUE for the deny-all model to apply to
--   anon/authenticated roles (service_role bypasses RLS, which is intentional).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_rls boolean;
BEGIN
  SELECT relrowsecurity
    INTO v_rls
    FROM pg_class
   WHERE relname = 'owner'
     AND relnamespace = 'public'::regnamespace;

  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion 5 (RLS enabled on owner, Req 18.1) failed: pg_class.relrowsecurity = %', v_rls;
  END IF;
END $$;

ROLLBACK;
