-- follows / profile_visits per post (2026-08-03).
--
-- 0011's comment claimed these were unreadable for a reels account. That claim came
-- from a summarised doc table that was never verified, and Instagram's own Help Centre
-- describes Follows as a reel insight. The columns exist so the question can be
-- answered with this account's real API responses instead of a scraped table; if Meta
-- rejects the metrics for REELS they stay null and the error body says why (see the
-- growth request in instagram.ts, which logs the rejection verbatim).
ALTER TABLE post_stats ADD COLUMN follows INTEGER;
ALTER TABLE post_stats ADD COLUMN profile_visits INTEGER;
