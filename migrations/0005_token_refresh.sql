-- Set when an automatic token refresh fails for a reason no retry can fix. A
-- lapsed Instagram token can only be replaced by re-authorizing by hand, so the
-- cron stops trying and the dashboard asks instead.
ALTER TABLE accounts ADD COLUMN needs_reconnect INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN reconnect_reason TEXT;

-- Reconciliation asks, once per run, which of an account's recent comments
-- already produced a send. Without this that's a scan of the whole log.
CREATE INDEX IF NOT EXISTS idx_sends_account_recent ON sends(ig_user_id, created_at);

-- The cron has no request to read the hostname from, and a recovered DM whose
-- tracked link points at the wrong host is worse than no DM at all. Remembered
-- from whichever request last served this instance, so a fork configures itself.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
