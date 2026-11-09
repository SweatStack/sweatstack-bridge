-- When a connection's health history was asked for, so it's asked for once. Null until then.
ALTER TABLE connections ADD COLUMN wellness_history_done_at INTEGER;
