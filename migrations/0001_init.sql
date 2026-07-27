-- Connected Instagram accounts. Tokens are AES-GCM encrypted with ENCRYPTION_KEY.
CREATE TABLE IF NOT EXISTS accounts (
  ig_user_id       TEXT PRIMARY KEY,   -- the 17841… Business ID webhooks use
  username         TEXT NOT NULL,
  token_encrypted  TEXT NOT NULL,
  token_expires_at INTEGER,            -- epoch ms; long-lived tokens last ~60 days
  connected_at     INTEGER NOT NULL,
  last_refreshed_at INTEGER
);

CREATE TABLE IF NOT EXISTS links (
  id         TEXT PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,     -- short code used in /l/:code
  target_url TEXT NOT NULL,
  clicks     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id            TEXT PRIMARY KEY,
  ig_user_id    TEXT NOT NULL REFERENCES accounts(ig_user_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  media_id      TEXT,                  -- NULL = any post on the account
  keyword       TEXT NOT NULL,
  match_mode    TEXT NOT NULL DEFAULT 'whole_word',  -- 'whole_word' | 'contains'
  dm_message    TEXT NOT NULL,         -- supports {username} and {link}
  public_reply  TEXT,                  -- NULL = don't reply publicly
  link_id       TEXT REFERENCES links(id) ON DELETE SET NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_lookup
  ON campaigns(ig_user_id, active);

CREATE TABLE IF NOT EXISTS sends (
  id                 TEXT PRIMARY KEY,
  campaign_id        TEXT NOT NULL,
  ig_user_id         TEXT NOT NULL,
  comment_id         TEXT NOT NULL,
  commenter_id       TEXT NOT NULL,
  commenter_username TEXT,
  status             TEXT NOT NULL,    -- 'sent' | 'failed' | 'duplicate'
  error              TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sends_recent ON sends(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sends_campaign ON sends(campaign_id, created_at DESC);
