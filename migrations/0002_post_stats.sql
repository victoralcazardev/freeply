-- Which post a send came from, so results can be read per post.
ALTER TABLE sends ADD COLUMN media_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sends_media ON sends(media_id);

-- Cached Instagram insights. Dashboard loads shouldn't hit the Graph API once
-- per post every time, and these numbers move slowly.
CREATE TABLE IF NOT EXISTS post_stats (
  media_id   TEXT PRIMARY KEY,
  reach      INTEGER,
  likes      INTEGER,
  comments   INTEGER,
  saved      INTEGER,
  shares     INTEGER,
  permalink  TEXT,
  fetched_at INTEGER NOT NULL
);
