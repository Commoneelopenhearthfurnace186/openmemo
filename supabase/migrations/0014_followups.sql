INSERT INTO dynamic_template (id, description, resolver, param_schema)
VALUES (
  'stale_followup',
  'Surfaces reminders delivered 3+ days ago without acknowledgement.',
  'resolveStaleFollowup',
  '{}'
) ON CONFLICT (id) DO NOTHING;
