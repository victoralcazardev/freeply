-- Enough to recognise a post at a glance. CDN thumbnail URLs expire, which is
-- fine: they're refreshed on the same 15-minute cycle as the metrics.
ALTER TABLE post_stats ADD COLUMN caption TEXT;
ALTER TABLE post_stats ADD COLUMN thumbnail_url TEXT;
ALTER TABLE post_stats ADD COLUMN media_type TEXT;
