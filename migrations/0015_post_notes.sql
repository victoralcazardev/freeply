-- The editorial layer for the cash.builds workspace (2026-08-12).
--
-- `post_stats` holds what Instagram measured. This holds what we concluded about
-- it: the format tag, a one-line verdict, and the reasoning. Until now those
-- lived as a JavaScript object literal baked into dashboard.html, which meant
-- judging a post required a code edit and a worker deploy — so in practice posts
-- went unjudged, and the judgements that did exist went stale silently (three of
-- them still named record-holders that had been beaten weeks earlier).
--
-- Keyed by SHORTCODE, not media_id, for two reasons:
--   1. A deleted post vanishes from account_media, and its judgement is exactly
--      the thing worth keeping — four of the account's posts are deleted and
--      each one's row explains why it can never be cited again. An FK to
--      account_media would delete the conclusion along with the evidence.
--   2. The shortcode is what a human reads off a permalink, so a note can be
--      written by hand or over MCP without looking up an opaque media id first.
-- The join back to stats is done in TypeScript (db.postStatsReport), which
-- derives the shortcode from the permalink — SQLite string-munging in the query
-- would be the same work, less legibly.
--
-- `pill` is presentation (good/warn/debt/mute) and is stored rather than derived
-- because the judgement of whether something is a problem is editorial, not a
-- function of any metric. No numbers go in `status` or `why`: they are prose,
-- nothing refreshes them, and a stale sentence beside a live number is how the
-- page told three different stories about the same post.
CREATE TABLE IF NOT EXISTS post_notes (
  shortcode  TEXT PRIMARY KEY,
  fmt        TEXT,
  status     TEXT,
  pill       TEXT,
  why        TEXT,
  updated_at INTEGER NOT NULL
);
