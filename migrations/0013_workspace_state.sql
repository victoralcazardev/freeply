-- Card state for the cash.builds workspace (2026-08-03).
--
-- Plan/queue/backlog/milestones/ideas were client-side only: seeded from the page
-- script, then kept in `cbops-*` localStorage keys. That is per-browser storage, so
-- the laptop and the phone each held a private copy and silently disagreed —
-- checking off a card on one was invisible to the other. This table is the shared
-- copy the page reconciles against.
--
-- One row per section, value stored whole. The page mutates a section as a unit
-- (reorder, add, delete, check off all rewrite the same {v, items} blob), so
-- splitting cards into rows would buy nothing and cost a join. Whole-section rows
-- also mean the conflict unit is a section: editing Ideas on the phone can never
-- clobber a queue card checked off on the laptop.
--
-- Reconciliation is last-write-wins on updated_at, server clock. Two devices
-- editing the SAME section while one is offline will lose the earlier edit — there
-- is no merge here, and for a single-operator board that tradeoff is deliberate.
CREATE TABLE IF NOT EXISTS workspace_state (
  section    TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
