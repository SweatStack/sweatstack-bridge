-- The ids of signed disconnect requests already taken, so one can't be sent again.
CREATE TABLE seen_jtis (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX seen_jtis_expiry ON seen_jtis (expires_at);
