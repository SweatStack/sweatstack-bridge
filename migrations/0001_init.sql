-- Times are seconds since the epoch.

-- SweatStack's registration, one per platform.
CREATE TABLE clients (
  provider TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  registered_at INTEGER NOT NULL
) STRICT;

-- One sign-in, from the authorization request to the code. Using the code deletes the row.
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  platform_verifier TEXT NOT NULL,
  rp_client_id TEXT NOT NULL,
  rp_state TEXT NOT NULL,
  rp_nonce TEXT,
  rp_redirect_uri TEXT NOT NULL,
  rp_code_challenge TEXT NOT NULL,
  taken_at INTEGER,
  code_hash TEXT UNIQUE,
  sub TEXT,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX flows_expiry ON flows (expires_at);

-- One platform account. `sub` is the only id the bridge keeps for an athlete.
CREATE TABLE connections (
  sub TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  user_id TEXT,
  rp_state TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  refresh_claimed_until INTEGER,
  permissions TEXT, -- a JSON list; NULL means unknown, not none
  needs_reconnect INTEGER NOT NULL DEFAULT 0,
  backfill_cursor TEXT,
  backfill_done_at INTEGER,
  consented_at INTEGER NOT NULL
) STRICT;
CREATE INDEX connections_refresh_due ON connections (refresh_expires_at);
CREATE INDEX connections_without_user ON connections (consented_at) WHERE user_id IS NULL;

-- SweatStack's tokens, cached because each mint leaves an issuance row there.
CREATE TABLE tokens (
  holder TEXT PRIMARY KEY, -- "client", or a SweatStack user id
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

-- The job queue. A repeated ping adds no row; kinds without an external_id leave it NULL and never conflict.
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY,
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
CREATE INDEX inbox_due ON inbox (next_attempt_at) WHERE done_at IS NULL;
CREATE INDEX inbox_finished ON inbox (done_at) WHERE done_at IS NOT NULL;
CREATE INDEX inbox_by_sub ON inbox (sub);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Made here, once, so they can't be missing. Changing subject_key would make every athlete a new user.
-- The signing key can't be made in SQL; the deploy script adds it (scripts/lib/signing-key.mjs).
INSERT INTO meta (key, value) VALUES
  ('webhook_secret', lower(hex(randomblob(32)))),
  ('subject_key', lower(hex(randomblob(32))));
