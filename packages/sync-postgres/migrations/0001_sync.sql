CREATE SCHEMA IF NOT EXISTS furin_sync;

CREATE TABLE IF NOT EXISTS furin_sync.mutations (
  namespace text NOT NULL,
  mutation_key text NOT NULL,
  mutation_id uuid NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('in-progress', 'succeeded')),
  response_status integer,
  response_headers jsonb,
  response_body bytea,
  lease_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (namespace, mutation_key),
  UNIQUE (mutation_id)
);

CREATE TABLE IF NOT EXISTS furin_sync.streams (
  namespace text PRIMARY KEY,
  current_cursor bigint NOT NULL DEFAULT 0,
  oldest_cursor bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS furin_sync.changes (
  namespace text NOT NULL,
  cursor bigint NOT NULL,
  invalidations jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, cursor)
);

CREATE INDEX IF NOT EXISTS furin_sync_mutations_expiry_idx
  ON furin_sync.mutations (expires_at);

CREATE INDEX IF NOT EXISTS furin_sync_changes_created_idx
  ON furin_sync.changes (namespace, created_at);
