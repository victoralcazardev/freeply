-- Reel-grade metrics. reach/likes under-describe a reel: ranking runs on views,
-- the 3-second skip, and watch time, and the API exposes all three (views,
-- reels_skip_rate, ig_reels_avg_watch_time). The latter two are REELS-only and
-- flagged "in development" by Meta, so every column stays nullable and a photo
-- or carousel simply never fills them.
ALTER TABLE post_stats ADD COLUMN views INTEGER;
ALTER TABLE post_stats ADD COLUMN skip_rate REAL;
ALTER TABLE post_stats ADD COLUMN avg_watch_ms INTEGER;
