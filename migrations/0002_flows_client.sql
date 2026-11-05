-- Which client a flow was started for, so that its code can't be used by a client that replaced it.
-- A flow already under way has no client to match, and its sign-in has to start again.
ALTER TABLE flows ADD COLUMN rp_client_id TEXT NOT NULL DEFAULT '';
