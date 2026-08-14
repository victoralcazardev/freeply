-- Disconnecting an account used to DELETE its row, and campaigns.ig_user_id
-- ON DELETE CASCADE (0001_init.sql) took every one of that account's campaigns
-- with it — a disconnect-then-reconnect of the same account silently wiped
-- every campaign, since reconnecting inserts a fresh row rather than reviving
-- the old one. Disconnecting now flips this flag instead of deleting the row,
-- so the cascade never fires; campaigns are deactivated in application code
-- and sit here for the same ig_user_id to find on reconnect.
ALTER TABLE accounts ADD COLUMN disconnected_at INTEGER;
