CREATE TABLE IF NOT EXISTS owner_context (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category    text NOT NULL,
  key         text NOT NULL UNIQUE,
  value       text NOT NULL,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS owner_context_category_idx ON owner_context (category);
ALTER TABLE owner_context ENABLE ROW LEVEL SECURITY;
