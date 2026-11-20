-- Prospect conversations: the operator's first DM, the reply, and the drafts
-- that move a lead towards a call.
--
-- A thread is inert until the exact echo of the M1 comes back. `igsid` stays
-- NULL and nothing in the conversation is read or stored until then; the echo
-- is the only automatic enrollment. `m1_sha` is the hash of the normalized text
-- the operator copied, and the identity is the `recipient.id` Meta returns in
-- that echo — never a handle guess, a prefix, or a time window (S11).
--
-- `ig_user_id` is in every lookup because each connected account sees the same
-- person through its own event envelope. Keying only on the peer id would let a
-- thread enrolled on one account capture events from another.
CREATE TABLE IF NOT EXISTS prospect_threads (
  lead_id          TEXT PRIMARY KEY,   -- Sheet row identity, not the handle
  ig_user_id       TEXT NOT NULL REFERENCES accounts(ig_user_id) ON DELETE CASCADE,
  igsid            TEXT,               -- peer id from the M1 echo; NULL until enrolled
  handle           TEXT NOT NULL,
  name             TEXT,
  nicho            TEXT,
  state            TEXT NOT NULL DEFAULT 'm1_pendiente'
                   CHECK (state IN ('m1_pendiente', 'm1_sin_confirmar', 'enrolled', 'closed')),
  m1_sha           TEXT,               -- sha256 of the normalized expected M1
  m1_registered_at INTEGER,
  version          INTEGER NOT NULL DEFAULT 0,
  last_inbound_at  INTEGER,
  last_outbound_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- SQLite allows many NULLs in a unique index, which is what lets every
-- un-enrolled thread coexist while an enrolled peer is claimed once per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_threads_peer
  ON prospect_threads(ig_user_id, igsid) WHERE igsid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prospect_threads_pending
  ON prospect_threads(ig_user_id, state, m1_sha);

-- `mid` is Meta's id and the dedupe key for both directions: a redelivered
-- webhook inserts nothing, and an echo of a message we sent by API is the same
-- message rather than a second one.
CREATE TABLE IF NOT EXISTS prospect_messages (
  mid         TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL REFERENCES prospect_threads(lead_id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  origin      TEXT NOT NULL CHECK (origin IN ('webhook', 'echo_m1', 'api', 'owner')),
  text        TEXT NOT NULL,
  sent_at     INTEGER NOT NULL,
  idem        TEXT,                  -- our own idempotency key for API sends
  drafted_at  INTEGER,
  answered_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_messages_idem
  ON prospect_messages(lead_id, idem) WHERE idem IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prospect_messages_thread
  ON prospect_messages(lead_id, sent_at);

-- Drafts carry the conversation version they were written against. A mismatch
-- means a message arrived while it was waiting, so it must be redrafted rather
-- than sent against a conversation nobody read.
CREATE TABLE IF NOT EXISTS prospect_drafts (
  draft_id     TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL REFERENCES prospect_threads(lead_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('m1', 'reply')),
  stage        TEXT,
  text         TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting', 'approved', 'invalidated', 'skipped', 'sent',
                                 'expired', 'send_state_unknown')),
  decided_at   INTEGER,
  decided_text TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prospect_drafts_pending
  ON prospect_drafts(lead_id, status);

-- The CLI writes these and the Worker obeys them: without a current row the
-- Worker never sends on its own. `gate_reason` empty means authorized.
CREATE TABLE IF NOT EXISTS prospect_authorizations (
  draft_id    TEXT NOT NULL REFERENCES prospect_drafts(draft_id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  gate_reason TEXT NOT NULL DEFAULT '',
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prospect_authorizations_draft
  ON prospect_authorizations(draft_id, expires_at);
