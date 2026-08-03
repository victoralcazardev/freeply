-- Growth-side metrics the reel table was missing (2026-08-03).
--
-- Why these three and not `follows`: the media-level `follows` and `profile_visits`
-- metrics are FEED/STORY only — a REELS media never returns them — and the
-- account-level `follower_count` / `follows_and_unfollows` are withheld below 100
-- followers. So per-post follow attribution is simply not readable for a reels
-- account this size. These are the closest readable substitutes.
--
-- total_watch_ms  ig_reels_video_view_total_time — total watch time across all
--                 views, not the average. Catches replays, and it's nearer to what
--                 ranking actually optimizes than avg_watch_ms alone. REELS only,
--                 "in development", so nullable like its neighbours.
-- reposts         reposts_count, a media FIELD (not an insights metric), added to
--                 the media endpoint in the April 2026 update. FEED + REELS, and
--                 only readable by the media owner. EXPERIMENTS.md ranks repost
--                 rate fifth in the metric hierarchy and there was no way to read it.
-- interactions    total_interactions — "in development"; feed posts won't fill it
--                 because it rides in the reels-gated request (see instagram.ts).
ALTER TABLE post_stats ADD COLUMN total_watch_ms INTEGER;
ALTER TABLE post_stats ADD COLUMN reposts INTEGER;
ALTER TABLE post_stats ADD COLUMN interactions INTEGER;
