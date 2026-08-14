-- Self-sent DMs, kept because the operator messages reel ideas between their own
-- two Instagram accounts and had no way to get them back out.
--
-- This is a recorder, not a reader, and the difference is forced by Meta: the
-- conversations API returns only the 20 most recent messages in a thread and
-- errors on anything older ("message has been deleted"). An on-demand reader
-- would therefore return a silently truncated slice of history and look like it
-- worked. The webhook already delivers every inbound DM in real time; until now
-- handleWebhook parsed them only far enough to find story replies and dropped
-- the rest. Storing them is what makes history exist at all.
--
-- Only messages between the operator's OWN accounts are stored — see the
-- dm_self_ids setting seeded below. A stranger's DM is not a reel idea, and
-- keeping one would park other people's messages in this database indefinitely
-- for no gain.
--
-- raw_json holds the whole messaging event verbatim, and that is deliberate
-- rather than lazy. The shape Meta uses for a shared reel could not be observed
-- before this shipped: tokens are AES-GCM encrypted with a worker-only key, so
-- there is no local probe, and the docs say only "the image or video URL for a
-- share" is included — no permalink. A wrong parse can be corrected on the
-- stored rows later; a field never stored is gone with the CDN URL's expiry.
CREATE TABLE IF NOT EXISTS dm_inbox (
  mid              TEXT PRIMARY KEY,   -- Meta's message id; also the dedupe key for webhook retries
  ig_user_id       TEXT NOT NULL,      -- the connected account the delivery arrived on (17841… form)
  sender_id        TEXT NOT NULL,
  recipient_id     TEXT,
  -- Which direction this was seen from. An echo is the operator's own outbound
  -- message reflected back on the sending account's webhook, and it is the ONLY
  -- way to capture ideas sent from the connected account to the unconnected one.
  is_echo          INTEGER NOT NULL DEFAULT 0,
  text             TEXT,
  -- Best-effort extraction, every column nullable on purpose: a share may carry
  -- an expiring CDN URL and nothing else.
  attachment_type  TEXT,
  shared_url       TEXT,
  shared_media_id  TEXT,
  raw_json         TEXT NOT NULL,
  received_at      INTEGER NOT NULL,
  processed_at     INTEGER             -- set once the idea has been folded into the queue
);

CREATE INDEX IF NOT EXISTS idx_dm_inbox_recent ON dm_inbox(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_inbox_open ON dm_inbox(processed_at, received_at DESC);

-- The operator's own Instagram Business ids, comma-separated. A setting rather
-- than a constant because the account they send ideas FROM is typically NOT
-- connected to this worker — it has no row in `accounts`, so the allowlist
-- cannot be derived from there, and adding an account later must not require a
-- deploy.
--
-- Seeded EMPTY, which switches the whole feature off: with no ids configured
-- extractSelfDMs stores nothing, so a fresh install never starts quietly keeping
-- messages nobody asked it to keep. Real ids are operator config and do not
-- belong in a shared migration, the same way `database_id` doesn't belong in a
-- committed wrangler.jsonc. Set them per install:
--
--   wrangler d1 execute freeply --remote --command \
--     "UPDATE settings SET value = '17841…,17841…' WHERE key = 'dm_self_ids'"
--
-- Both ids are the Instagram Business `17841…` form — the same id webhooks use,
-- not the app-scoped one. Get them from account_media, or from /me?fields=user_id.
INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES ('dm_self_ids', '', 0);
