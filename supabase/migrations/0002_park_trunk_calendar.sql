-- pgvector is required by memory_bubble.embedding before that table is created.
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- The_Park
-- -----------------------------------------------------------------------------
CREATE TABLE memory_bubble (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content     text NOT NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  source      text,
  language    text NOT NULL DEFAULT 'es',
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- HNSW cosine index restricted to live rows (excludes soft-deleted bubbles).
CREATE INDEX memory_bubble_embedding_idx
  ON memory_bubble USING hnsw (embedding vector_cosine_ops)
  WHERE deleted_at IS NULL;

-- GIN index on tags to accelerate tag-array filters (`tags && $1`).
CREATE INDEX memory_bubble_tags_idx ON memory_bubble USING gin (tags);

-- -----------------------------------------------------------------------------
-- Memory_Trunk (file content lives in Supabase Storage; this table holds metadata)
-- -----------------------------------------------------------------------------
CREATE TABLE trunk_object (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  storage_path  text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Audit & inbound
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Raw Telegram updates kept for debugging and reprocessing of intent envelopes.
CREATE TABLE inbound_message (
  id              bigserial PRIMARY KEY,
  telegram_update jsonb NOT NULL,
  raw_text        text,
  intent_envelope jsonb,
  processed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
