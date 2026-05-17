-- Materialises every reminder whose next_trigger_at is at or before now() into
-- the job_outbox queue. Designed to be invoked once per minute by pg_cron.
--
-- Idempotency guarantee: the idempotency_key encodes (reminder_id, occurrence
-- epoch seconds), and job_outbox enforces UNIQUE(idempotency_key). Combined
-- with ON CONFLICT DO NOTHING this means running the function N consecutive
-- times for the same wall clock produces exactly the same set of outbox rows
-- as running it once, satisfying requirement 16.3.
CREATE OR REPLACE FUNCTION select_due_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO job_outbox (reminder_id, occurrence_at, idempotency_key)
  SELECT r.id, r.next_trigger_at,
         'rem:' || r.id::text || ':' || extract(epoch from r.next_trigger_at)::bigint
  FROM   reminder r
  WHERE  r.status IN ('scheduled', 'active')
    AND  r.next_trigger_at IS NOT NULL
    AND  r.next_trigger_at <= now()
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION select_due_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION select_due_reminders() TO postgres;

-- Atomically claims a batch of due jobs from job_outbox and transitions them
-- from 'pending' (or stale 'in_flight') to 'in_flight'. Returns the full
-- updated rows so the dispatcher Edge Function sees the incremented attempts
-- counter and can decide whether to dead-letter on the next failure.
--
-- A job is considered claimable when:
--   * status = 'pending' and next_attempt_at has elapsed, OR
--   * status = 'in_flight' and in_flight_until has elapsed (visibility
--     timeout expired — the previous dispatcher crashed or timed out before
--     acknowledging, so we re-claim and let the new attempt proceed).
--
-- Visibility timeout: every claim sets in_flight_until = now() + 2 minutes.
-- If the dispatcher does not call mark_job_delivered or mark_job_failed
-- within that lease, the job becomes claimable again and another dispatcher
-- pass will pick it up. Two minutes comfortably covers a single Telegram
-- send plus DeepSeek calls while still recovering quickly from
-- crashes (requirement 16.4 — exclusive, concurrency-safe transitions).
--
-- FOR UPDATE SKIP LOCKED on the inner SELECT means concurrent dispatcher
-- invocations never block on each other and never see the same job: each
-- session locks a disjoint slice of rows. In personal use only one
-- dispatcher runs at a time, but the lock is cheap and makes the function
-- safe under any pg_cron drift or manual re-invocation.
CREATE OR REPLACE FUNCTION claim_due_jobs(batch integer DEFAULT 20)
RETURNS SETOF job_outbox
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE job_outbox
     SET status = 'in_flight',
         attempts = attempts + 1,
         in_flight_until = now() + interval '2 minutes'
   WHERE id IN (
     SELECT id FROM job_outbox
      WHERE (status = 'pending' AND next_attempt_at <= now())
         OR (status = 'in_flight' AND in_flight_until < now())
      ORDER BY next_attempt_at ASC
      LIMIT batch
      FOR UPDATE SKIP LOCKED
   )
   RETURNING *;
$$;

REVOKE ALL ON FUNCTION claim_due_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_jobs(integer) TO postgres;

-- Success path for the dispatcher. Marks a claimed job as delivered, stamps
-- delivered_at, releases the in_flight lease, and clears any prior error
-- string. Idempotent by construction: re-marking a row that is already in
-- 'delivered' simply re-applies the same end state without changing anything
-- meaningful, so a duplicate ack from the dispatcher is harmless
-- (requirement 16.5).
CREATE OR REPLACE FUNCTION mark_job_delivered(p_job_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE job_outbox
     SET status = 'delivered',
         delivered_at = now(),
         in_flight_until = NULL,
         last_error = NULL
   WHERE id = p_job_id;
$$;

REVOKE ALL ON FUNCTION mark_job_delivered(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_job_delivered(uuid) TO postgres;

-- Failure path for the dispatcher. Implements exponential backoff up to
-- 5 attempts, then transitions the job to 'dead_letter' and returns the
-- updated row so the caller can detect the dead-letter transition and
-- notify the owner separately (requirements 16.6, 16.7).
--
-- Backoff formula: next_attempt_at = now() + (2 ^ attempts) minutes, where
-- attempts was already incremented by claim_due_jobs BEFORE this function
-- runs. So a first failure (attempts=1) waits 2 min, then 4, 8, 16, 32 min;
-- once attempts reaches 5 the job is dead-lettered instead of retried.
--
-- The SELECT ... FOR UPDATE serialises this update against any concurrent
-- claim_due_jobs pass that might otherwise re-claim a stale lease while we
-- are still computing the new state.
CREATE OR REPLACE FUNCTION mark_job_failed(p_job_id uuid, p_error text)
RETURNS job_outbox
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_job job_outbox;
  v_max_attempts constant integer := 5;
BEGIN
  -- Read current attempts count to decide whether to dead-letter.
  SELECT * INTO v_job FROM job_outbox WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_job_failed: job % not found', p_job_id;
  END IF;

  IF v_job.attempts >= v_max_attempts THEN
    -- Move to dead_letter; the dispatcher will notify the owner separately.
    UPDATE job_outbox
       SET status = 'dead_letter',
           last_error = p_error,
           in_flight_until = NULL
     WHERE id = p_job_id
     RETURNING * INTO v_job;
  ELSE
    -- Schedule a retry with exponential backoff (2^attempts minutes).
    UPDATE job_outbox
       SET status = 'pending',
           last_error = p_error,
           in_flight_until = NULL,
           next_attempt_at = now() + (power(2, v_job.attempts) || ' minutes')::interval
     WHERE id = p_job_id
     RETURNING * INTO v_job;
  END IF;

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION mark_job_failed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_job_failed(uuid, text) TO postgres;

-- Vector similarity search over memory_bubble for The_Park. Returns up to k
-- bubbles ranked by cosine similarity to the supplied query_embedding, with
-- their content truncated to 200 characters for compact previews
-- (requirements 13.2, 13.3). An optional tag_filter restricts results to
-- bubbles overlapping the given tag set via the && array operator
-- (requirement 13.4).
--
-- Index used: memory_bubble_embedding_idx — an HNSW partial index on
-- (embedding vector_cosine_ops) WHERE deleted_at IS NULL. The WHERE clause
-- here mirrors the index predicate (deleted_at IS NULL AND embedding IS NOT
-- NULL), so the planner can use the partial HNSW index for the ORDER BY
-- embedding <=> query_embedding lookup.
--
-- The <=> operator returns pgvector's cosine distance, so similarity is
-- 1 - distance (higher = more similar). The 0.3 similarity threshold from
-- requirement 13.5 is intentionally NOT enforced here: the caller in the
-- The_Park handler decides whether to surface a "no_results" message based
-- on the returned scores, keeping that policy out of the SQL layer.
CREATE OR REPLACE FUNCTION search_park(
  query_embedding vector(1536),
  tag_filter text[] DEFAULT NULL,
  k integer DEFAULT 20
)
RETURNS TABLE (id uuid, content text, score float)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT mb.id,
         left(mb.content, 200) AS content,
         1 - (mb.embedding <=> query_embedding) AS score
  FROM   memory_bubble mb
  WHERE  mb.deleted_at IS NULL
    AND  mb.embedding IS NOT NULL
    AND  (tag_filter IS NULL OR mb.tags && tag_filter)
  ORDER  BY mb.embedding <=> query_embedding
  LIMIT  k;
$$;

REVOKE ALL ON FUNCTION search_park(vector(1536), text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_park(vector(1536), text[], integer) TO postgres;
