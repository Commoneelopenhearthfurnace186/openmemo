-- Required for gen_random_uuid().
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Owner: singleton table (exactly one row allowed via CHECK (id = 1)).
-- -----------------------------------------------------------------------------
CREATE TABLE owner (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  chat_id       bigint  NOT NULL UNIQUE,
  display_name  text,
  timezone      text    NOT NULL DEFAULT 'UTC',
  language      text    NOT NULL DEFAULT 'en',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Dynamic templates catalog (rows seeded in migration 0003).
-- -----------------------------------------------------------------------------
CREATE TABLE dynamic_template (
  id            text PRIMARY KEY,
  description   text NOT NULL,
  param_schema  jsonb NOT NULL DEFAULT '{}',
  resolver      text NOT NULL
);

-- -----------------------------------------------------------------------------
-- ENUMs
-- -----------------------------------------------------------------------------
CREATE TYPE reminder_kind AS ENUM (
  'static', 'recurring', 'dynamic', 'conditional', 'escalation', 'composite'
);

CREATE TYPE reminder_status AS ENUM (
  'scheduled', 'active', 'paused', 'completed', 'cancelled', 'expired', 'failed'
);

CREATE TYPE job_status AS ENUM (
  'pending', 'in_flight', 'delivered', 'failed', 'dead_letter'
);

-- -----------------------------------------------------------------------------
-- The_Office: reminders (unified table covering all 6 kinds).
-- linked_task_id and linked_list_item_id FKs are added at the end of this
-- migration, after `task` and `list_item` exist.
-- -----------------------------------------------------------------------------
CREATE TABLE reminder (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                reminder_kind NOT NULL,
  status              reminder_status NOT NULL DEFAULT 'scheduled',
  content             text,
  raw_text            text,
  recurrence_rule     text,
  start_at            timestamptz,
  next_trigger_at     timestamptz,
  deadline_at         timestamptz,
  timezone            text NOT NULL DEFAULT 'UTC',
  -- Conditional
  condition           jsonb,
  then_action         jsonb,
  re_evaluation_rule  text,
  -- Escalation
  escalation_rule     jsonb,
  stop_condition      jsonb,
  attempt_count       integer NOT NULL DEFAULT 0,
  -- Composite / pre-notification
  parent_reminder_id  uuid REFERENCES reminder(id) ON DELETE CASCADE,
  -- Dynamic
  template_id         text REFERENCES dynamic_template(id),
  template_params     jsonb,
  -- Auto-generated reminder linkage (FKs added at end of file).
  linked_task_id      uuid,
  linked_list_item_id uuid,
  -- Auditoría
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'recurring'   OR recurrence_rule IS NOT NULL),
  CHECK (kind <> 'dynamic'     OR template_id     IS NOT NULL),
  CHECK (kind <> 'conditional' OR condition       IS NOT NULL),
  CHECK (kind <> 'escalation'  OR escalation_rule IS NOT NULL),
  CHECK (attempt_count <= 50)
);

CREATE INDEX reminder_due_idx ON reminder (next_trigger_at)
  WHERE status IN ('scheduled', 'active');
CREATE INDEX reminder_parent_idx ON reminder (parent_reminder_id);

-- -----------------------------------------------------------------------------
-- The_Office: job_outbox (one row per occurrence, dedup via idempotency_key).
-- -----------------------------------------------------------------------------
CREATE TABLE job_outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id       uuid NOT NULL REFERENCES reminder(id) ON DELETE CASCADE,
  occurrence_at     timestamptz NOT NULL,
  idempotency_key   text NOT NULL UNIQUE,
  status            job_status NOT NULL DEFAULT 'pending',
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  in_flight_until   timestamptz,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_pending_idx ON job_outbox (next_attempt_at)
  WHERE status IN ('pending', 'in_flight');

-- -----------------------------------------------------------------------------
-- The_Office: lists & tasks.
-- -----------------------------------------------------------------------------
CREATE TABLE list (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE list_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id      uuid NOT NULL REFERENCES list(id) ON DELETE CASCADE,
  content      text NOT NULL,
  position     integer NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (list_id, position)
);

CREATE TABLE task (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  description  text,
  due_at       timestamptz,
  priority     integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  tags         text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Deferred FKs: reminder -> task, reminder -> list_item.
-- Added here because both target tables must exist first.
-- -----------------------------------------------------------------------------
ALTER TABLE reminder
  ADD CONSTRAINT reminder_linked_task_fk
    FOREIGN KEY (linked_task_id) REFERENCES task(id) ON DELETE SET NULL;

ALTER TABLE reminder
  ADD CONSTRAINT reminder_linked_list_item_fk
    FOREIGN KEY (linked_list_item_id) REFERENCES list_item(id) ON DELETE SET NULL;
