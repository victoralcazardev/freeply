-- The two extras the stateless Pi-side CLI needs on top of 0011, both nullable
-- so every row written before this migration keeps working untouched.

-- Which M1 variant (A/B/C, L25) the CLI wrote this draft under. Replies and the
-- drafts that predate the A/B test have none. The export carries it so `status`
-- can give each variant's rate with its own denominator (M1s sent, L24).
ALTER TABLE prospect_drafts ADD COLUMN variant_id TEXT;

-- The profile evidence a reply can quote (L10/L11, T14): the team's motivo de
-- encaje is the base, and the profile read is what makes an [actividad reciente]
-- fact checkable. `profile_summary` holds a JSON object and, per L12, never an id
-- Meta handed back — a profile read is not a way to address a message. The
-- Worker refuses an id-shaped payload instead of storing it next to an IGSID.
-- `profile_read_at` is when the profile was read, which is what the gate calls
-- evidence; a summary without one is stamped when it reaches D1.
ALTER TABLE prospect_threads ADD COLUMN profile_summary TEXT;
ALTER TABLE prospect_threads ADD COLUMN profile_read_at INTEGER;
