-- Recent posts per account, so the campaign form can offer a picker instead of
-- asking for a raw post ID that nobody knows where to find.
--
-- Cached the way post_stats is: refreshed on the same 15-minute TTL, and the
-- CDN thumbnail URLs are expected to expire on roughly that cycle too.
CREATE TABLE IF NOT EXISTS account_media (
  media_id      TEXT PRIMARY KEY,
  ig_user_id    TEXT NOT NULL,
  caption       TEXT,
  thumbnail_url TEXT,
  permalink     TEXT,
  media_type    TEXT,
  posted_at     INTEGER,           -- epoch ms; NULL when Meta omits the timestamp
  fetched_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_media_recent
  ON account_media(ig_user_id, posted_at DESC);
