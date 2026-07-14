CREATE TABLE IF NOT EXISTS furin_sync_mutations (
  namespace TEXT NOT NULL,
  mutation_key TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in-progress', 'succeeded')),
  response_status INTEGER,
  response_headers TEXT,
  response_body BLOB,
  lease_expires_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (namespace, mutation_key),
  UNIQUE (mutation_id)
);

CREATE TABLE IF NOT EXISTS furin_sync_streams (
  namespace TEXT PRIMARY KEY,
  current_cursor INTEGER NOT NULL DEFAULT 0,
  oldest_cursor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS furin_sync_changes (
  namespace TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  invalidations TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, cursor)
);

CREATE INDEX IF NOT EXISTS furin_sync_mutations_expiry_idx
  ON furin_sync_mutations (expires_at);

CREATE INDEX IF NOT EXISTS furin_sync_changes_created_idx
  ON furin_sync_changes (namespace, created_at);
