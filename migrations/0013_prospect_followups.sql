-- The follow-up of an M1 nobody answered (T19): a no-DM touch, one hand-sent
-- follow-up DM, and a close. Every column is nullable, so every row written
-- before this migration keeps working untouched.

-- When the thread enrolled — the M1 echo's own timestamp, which is the moment
-- the operator sent it. It is the anchor the follow-up days are counted from,
-- and it exists so a page render never has to reconstruct that moment from the
-- messages. Written by the echo handler; NULL until then.
ALTER TABLE prospect_threads ADD COLUMN enrolled_at INTEGER;

-- The two manual steps, marked by hand on /prospects. Nothing else ever writes
-- them: no API call, no autopilot pass, no cron.
ALTER TABLE prospect_threads ADD COLUMN touch_done_at INTEGER;      -- "Hecho" on the touch
ALTER TABLE prospect_threads ADD COLUMN followup_sent_at INTEGER;   -- "Enviado" on the DM

-- Why a thread closed, for the ones the Worker closed on its own. Today the only
-- value is 'no_reply' (day 14 with no inbound); NULL is every close a person
-- caused, and every thread still open.
ALTER TABLE prospect_threads ADD COLUMN close_reason TEXT;

-- Backfill the enrolment moment for threads that enrolled before this column
-- existed. The M1 echo is the truth; a thread whose echo row is somehow gone
-- falls back to its last outbound, then to when it last moved. Only enrolled
-- threads get one: an un-enrolled thread has no moment to count from.
UPDATE prospect_threads
SET enrolled_at = COALESCE(
  (SELECT MIN(m.sent_at) FROM prospect_messages m
    WHERE m.lead_id = prospect_threads.lead_id AND m.origin = 'echo_m1'),
  last_outbound_at,
  updated_at
)
WHERE igsid IS NOT NULL AND enrolled_at IS NULL;

-- The queue reads enrolled threads by this column and nothing else.
CREATE INDEX IF NOT EXISTS idx_prospect_threads_followup
  ON prospect_threads(state, enrolled_at);
