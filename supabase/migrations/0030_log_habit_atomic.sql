CREATE OR REPLACE FUNCTION public.log_habit_atomic(
  p_habit_id uuid,
  p_done_at timestamptz,
  p_note text DEFAULT NULL
)
RETURNS TABLE (habit_id uuid, streak integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cad integer;
  prev timestamptz;
  prev_streak integer;
  next_streak integer;
  gap_days integer;
BEGIN
  SELECT cadence_days, last_done_at, streak_count
  INTO cad, prev, prev_streak
  FROM habit
  WHERE id = p_habit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'habit % not found', p_habit_id;
  END IF;

  next_streak := 1;
  IF prev IS NOT NULL THEN
    gap_days := floor(extract(epoch FROM (p_done_at - prev)) / 86400)::integer;
    IF gap_days >= 0 AND gap_days <= cad + 1 THEN
      next_streak := COALESCE(prev_streak, 0) + 1;
    END IF;
  END IF;

  INSERT INTO habit_log (habit_id, done_at, note)
  VALUES (p_habit_id, p_done_at, p_note);

  UPDATE habit
  SET last_done_at = p_done_at, streak_count = next_streak
  WHERE id = p_habit_id;

  RETURN QUERY SELECT p_habit_id, next_streak;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_habit_atomic(uuid, timestamptz, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.log_habit_atomic(uuid, timestamptz, text) TO service_role;
