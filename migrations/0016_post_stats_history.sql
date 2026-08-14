-- Time series for post performance (2026-08-12).
--
-- `post_stats` is ONE MUTABLE ROW PER POST: the sweep upserts with
-- `ON CONFLICT (media_id) DO UPDATE`, so every reading overwrites the last one.
-- The hourly cron has therefore been destroying a data point every hour since it
-- was switched on, and the only trajectory anyone has is what a human happened to
-- copy into a markdown file by hand ("2,282 -> 4,401 across two days").
--
-- That missing history is what makes the account's numbers so hard to read. Two
-- questions cannot be answered without it, and both come up constantly:
--   1. Is a post doing well, or is it just older? A four-hour-old reel and a
--      settled one are not comparable, and today the table invites exactly that
--      comparison because every row is "current".
--   2. Did a post spike and stop, or does it have a tail? Same final number,
--      completely different lesson — one is a distribution accident, the other is
--      content that keeps being served.
-- With snapshots, posts get compared at equal AGE (24h vs 24h) instead of
-- settled-vs-fresh, which removes the single biggest confound in the channel log.
--
-- Append-only. One row per (media_id, observed_at).
--
-- WRITE RULE: a snapshot is inserted only when at least one metric differs from
-- that post's most recent snapshot. Posts settle, their numbers stop moving, and
-- the rows stop accumulating on their own — no retention policy, no cron to prune,
-- and no thousands of identical rows for a two-year-old post. Storage stays
-- proportional to how much the account actually changes rather than to how often
-- the cron happens to run.
--
-- `age_ms` is denormalized (observed_at - posted_at) so "the reading nearest 24h"
-- is an indexed range scan instead of a join back to account_media on every query.
-- Collection is deliberately NOT pinned to 24/48/72h marks: cron jitter would miss
-- them, and the nearest-snapshot-to-an-age query gives the same answer from
-- whatever cadence the sweep actually ran at.
CREATE TABLE IF NOT EXISTS post_stats_history (
  media_id       TEXT NOT NULL,
  observed_at    INTEGER NOT NULL,   -- epoch ms, server clock at the sweep
  age_ms         INTEGER,            -- observed_at - posted_at; NULL if posted_at unknown
  views          INTEGER,
  reach          INTEGER,
  skip_rate      REAL,
  avg_watch_ms   INTEGER,
  total_watch_ms INTEGER,
  interactions   INTEGER,
  likes          INTEGER,
  comments       INTEGER,
  saved          INTEGER,
  shares         INTEGER,
  PRIMARY KEY (media_id, observed_at)
);

-- The age-bucket query ("closest reading to 24h for every post") drives the
-- whole point of this table, so it gets the index rather than observed_at.
CREATE INDEX IF NOT EXISTS idx_post_stats_history_age
  ON post_stats_history(media_id, age_ms);
