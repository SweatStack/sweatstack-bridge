-- A job's row can go while a Worker is still on it, when its connection ends. Without AUTOINCREMENT the next
-- job takes the same id, and that Worker's result lands on it. SQLite can only add this by rebuilding the table.
CREATE TABLE inbox_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  sub TEXT NOT NULL,
  external_id TEXT,
  payload TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  done_at INTEGER,
  received_at INTEGER NOT NULL,
  UNIQUE (kind, sub, external_id)
) STRICT;
INSERT INTO inbox_new (id, kind, provider, sub, external_id, payload, attempts, next_attempt_at, lease_until, last_error, done_at, received_at)
  SELECT id, kind, provider, sub, external_id, payload, attempts, next_attempt_at, lease_until, last_error, done_at, received_at FROM inbox;
DROP TABLE inbox;
ALTER TABLE inbox_new RENAME TO inbox;
CREATE INDEX inbox_due ON inbox (next_attempt_at) WHERE done_at IS NULL;
CREATE INDEX inbox_finished ON inbox (done_at) WHERE done_at IS NOT NULL;
CREATE INDEX inbox_by_sub ON inbox (sub);
