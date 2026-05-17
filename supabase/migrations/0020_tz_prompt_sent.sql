-- Adds the flag that records whether the onboarding prompt has been
-- sent. Lets the webhook know if a HH:MM reply is expected.

ALTER TABLE owner
  ADD COLUMN IF NOT EXISTS tz_prompt_sent boolean NOT NULL DEFAULT false;

-- Existing owners are considered prompted so they don't see the flow.
UPDATE owner SET tz_prompt_sent = true WHERE id = 1;
