-- Track whether the owner has confirmed their timezone on first run.
-- While false, the webhook intercepts the message and walks the user
-- through a 2-turn onboarding instead of running the agent.

ALTER TABLE owner
  ADD COLUMN IF NOT EXISTS tz_confirmed boolean NOT NULL DEFAULT false;

-- Existing owners are considered confirmed so they don't get prompted.
UPDATE owner SET tz_confirmed = true WHERE id = 1;
