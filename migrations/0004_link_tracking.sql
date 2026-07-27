-- Whether the recipient sees a wrapped short link or the destination itself.
-- Untracked loses click data and the in-app-browser escape, but shows the real
-- domain, which reads as more trustworthy inside a DM.
ALTER TABLE links ADD COLUMN tracked INTEGER NOT NULL DEFAULT 1;
