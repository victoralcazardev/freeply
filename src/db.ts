import { decrypt, encrypt } from "./crypto";

export interface Account {
  igUserId: string;
  username: string;
  tokenExpiresAt: number | null;
  connectedAt: number;
  /** The refresh cron gave up; only re-authorizing by hand will fix it. */
  needsReconnect: boolean;
  reconnectReason: string | null;
}

export interface Campaign {
  id: string;
  igUserId: string;
  name: string;
  mediaId: string | null;
  /** Any one of these fires the campaign. Dedupe still keys on the campaign. */
  keywords: string[];
  matchMode: "whole_word" | "contains";
  /**
   * For an account-wide campaign, whether someone who comments on a second post
   * is messaged again. Ignored when mediaId is set — see dedupeKey().
   */
  dedupeScope: "per_post" | "campaign";
  /**
   * Also answer replies to this account's stories. Only consulted for an
   * account-wide campaign: a campaign pinned to a post is about that post.
   */
  storyReplies: boolean;
  /**
   * The question this campaign contributes to the account's Ice Breakers, or
   * null. Lives on Meta's servers once published — see publishIceBreakers.
   */
  iceBreaker: string | null;
  dmMessage: string;
  publicReply: string | null;
  linkId: string | null;
  active: boolean;
  createdAt: number;
}

/**
 * The key a commenter is claimed under in the account's Durable Object.
 *
 * Not simply the campaign id. An account-wide campaign watches every post, so
 * keying on the campaign alone means the first post someone comments on is the
 * only one that ever answers them — every later post is refused as a duplicate
 * of a message about something else.
 *
 * Falls back to the campaign id when the post isn't known. The webhook's media
 * id is optional and reconciliation always supplies one, so keying on a value
 * that might be absent would let the same comment claim under two different keys
 * depending on which path found it, and be messaged twice. Against a one-shot
 * private reply, one message too few beats one too many.
 *
 * **Assumes Meta's one-shot rule is per comment, not per commenter.** The rest of
 * this codebase says "once per commenter" (see sendPrivateReply), which if taken
 * literally would mean the second post can never be answered at all. The evidence
 * for per-comment is an observed thread on 25 July 2026: on another operator's
 * account, the same person commented on two posts and received two private
 * replies, both carrying Instagram's "messaged you about a comment you made on
 * their post" label. Not verified against our own account. If the stricter reading turns out to be right,
 * the second send is refused by Meta with a code that classify() treats as
 * permanent, so the claim is kept and the row lands as `failed` — visible in the
 * send log rather than silent, and no message is lost that would otherwise have
 * been delivered.
 */
export function dedupeKey(campaign: Campaign, mediaId?: string): string {
  const perPost = campaign.mediaId === null && campaign.dedupeScope === "per_post";
  return perPost && mediaId ? `${campaign.id}#${mediaId}` : campaign.id;
}

export interface Link {
  id: string;
  code: string;
  targetUrl: string;
  clicks: number;
  /** Campaign this link belongs to, or null if its campaign was deleted. */
  campaignName?: string | null;
  /** DMs sent by that campaign — the denominator for click-through. */
  dmsSent?: number;
  /** False sends the destination URL itself, with no wrapping or click data. */
  tracked?: boolean;
}

export interface Send {
  id: string;
  campaignId: string;
  commenterUsername: string | null;
  status: string;
  error: string | null;
  createdAt: number;
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * Accepts what people actually type. "example.com/x" becomes
 * "https://example.com/x"; anything that still isn't a URL returns null.
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    // Reject things like "https://hello" that parse but aren't reachable hosts.
    return url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Short, unambiguous code for /l/:code — no 0/O or 1/l/I to misread aloud. */
export function newLinkCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/* ---------------------------------------------------------------- accounts */

export async function upsertAccount(
  db: D1Database,
  key: string,
  account: { igUserId: string; username: string; accessToken: string; expiresIn?: number },
): Promise<void> {
  const encrypted = await encrypt(account.accessToken, key);
  const now = Date.now();
  const expiresAt = account.expiresIn ? now + account.expiresIn * 1000 : null;

  await db
    .prepare(
      `INSERT INTO accounts
         (ig_user_id, username, token_encrypted, token_expires_at, connected_at, last_refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (ig_user_id) DO UPDATE SET
         username = excluded.username,
         token_encrypted = excluded.token_encrypted,
         token_expires_at = excluded.token_expires_at,
         last_refreshed_at = excluded.last_refreshed_at,
         needs_reconnect = 0,
         reconnect_reason = NULL`,
    )
    .bind(account.igUserId, account.username, encrypted, expiresAt, now, now)
    .run();
}

export interface RefreshCandidate {
  igUserId: string;
  username: string;
  tokenExpiresAt: number | null;
  /** When the stored token was issued or last renewed — its age, in effect. */
  lastRefreshedAt: number | null;
  connectedAt: number;
}

/** Long-lived tokens last ~60 days. Only used to schedule a refresh for a token
 *  whose stored expiry is unknown; the refresh itself then records a real one. */
const ASSUMED_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Accounts whose token expires soon enough to act on.
 *
 * A NULL expiry — an OAuth response that omitted expires_in — would otherwise
 * never be refreshed and would die silently at ~60 days. Those are included once
 * the stored token is old enough that an assumed 60-day life lands inside the
 * same window, dated from its last refresh or, failing that, when it connected.
 *
 * Already-flagged accounts are excluded: the flag means a human has to
 * re-authorize, and calling Meta once a day until then only fills the log.
 */
export async function accountsDueForRefresh(
  db: D1Database,
  expiringBefore: number,
): Promise<RefreshCandidate[]> {
  const assumedIssueCutoff = expiringBefore - ASSUMED_TOKEN_LIFETIME_MS;
  const { results } = await db
    .prepare(
      `SELECT ig_user_id, username, token_expires_at, last_refreshed_at, connected_at
       FROM accounts
       WHERE needs_reconnect = 0
         AND (
           (token_expires_at IS NOT NULL AND token_expires_at < ?)
           OR (token_expires_at IS NULL
               AND COALESCE(last_refreshed_at, connected_at) < ?)
         )
       ORDER BY token_expires_at`,
    )
    .bind(expiringBefore, assumedIssueCutoff)
    .all<{
      ig_user_id: string;
      username: string;
      token_expires_at: number | null;
      last_refreshed_at: number | null;
      connected_at: number;
    }>();

  return results.map((r) => ({
    igUserId: r.ig_user_id,
    username: r.username,
    tokenExpiresAt: r.token_expires_at,
    lastRefreshedAt: r.last_refreshed_at,
    connectedAt: r.connected_at,
  }));
}

/** Writes a renewed token back, encrypted, and clears any reconnect flag. */
export async function updateAccountToken(
  db: D1Database,
  key: string,
  igUserId: string,
  accessToken: string,
  expiresIn: number,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `UPDATE accounts
       SET token_encrypted = ?, token_expires_at = ?, last_refreshed_at = ?,
           needs_reconnect = 0, reconnect_reason = NULL
       WHERE ig_user_id = ?`,
    )
    .bind(await encrypt(accessToken, key), now + expiresIn * 1000, now, igUserId)
    .run();
}

/** Stops the cron retrying and hands the problem to the dashboard's banner. */
export async function markNeedsReconnect(
  db: D1Database,
  igUserId: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE accounts SET needs_reconnect = 1, reconnect_reason = ? WHERE ig_user_id = ?`,
    )
    .bind(reason.slice(0, 300), igUserId)
    .run();
}

/** Accounts reconciliation should poll: connected, working, and worth polling. */
export async function accountsToReconcile(
  db: D1Database,
): Promise<Array<{ igUserId: string; username: string }>> {
  const { results } = await db
    .prepare(
      `SELECT a.ig_user_id, a.username
       FROM accounts a
       WHERE a.needs_reconnect = 0
         AND EXISTS (SELECT 1 FROM campaigns c
                      WHERE c.ig_user_id = a.ig_user_id AND c.active = 1)
       ORDER BY a.username`,
    )
    .all<{ ig_user_id: string; username: string }>();

  return results.map((r) => ({ igUserId: r.ig_user_id, username: r.username }));
}

/**
 * Comment IDs reconciliation should leave alone — either already settled, or
 * failed often enough that another attempt is just noise.
 *
 * A comment with only failures is deliberately still eligible: the usual cause
 * is an expired token, and once the account is reconnected the lead is still
 * inside its 7-day window and worth recovering.
 */
export async function settledCommentIds(
  db: D1Database,
  igUserId: string,
  since: number,
  maxFailures: number,
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT comment_id,
              SUM(CASE WHEN status IN ('sent','recovered','duplicate') THEN 1 ELSE 0 END) AS settled,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
       FROM sends
       WHERE ig_user_id = ? AND created_at > ?
       GROUP BY comment_id`,
    )
    .bind(igUserId, since)
    .all<{ comment_id: string; settled: number; failures: number }>();

  return new Set(
    results.filter((r) => r.settled > 0 || r.failures >= maxFailures).map((r) => r.comment_id),
  );
}

export async function getAccountToken(
  db: D1Database,
  key: string,
  igUserId: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT token_encrypted FROM accounts WHERE ig_user_id = ?`)
    .bind(igUserId)
    .first<{ token_encrypted: string }>();

  return row ? decrypt(row.token_encrypted, key) : null;
}

export async function listAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db
    .prepare(
      `SELECT ig_user_id, username, token_expires_at, connected_at,
              needs_reconnect, reconnect_reason
       FROM accounts ORDER BY username`,
    )
    .all<{
      ig_user_id: string;
      username: string;
      token_expires_at: number | null;
      connected_at: number;
      needs_reconnect: number;
      reconnect_reason: string | null;
    }>();

  return results.map((r) => ({
    igUserId: r.ig_user_id,
    username: r.username,
    tokenExpiresAt: r.token_expires_at,
    connectedAt: r.connected_at,
    needsReconnect: r.needs_reconnect === 1,
    reconnectReason: r.reconnect_reason,
  }));
}

export async function deleteAccount(db: D1Database, igUserId: string): Promise<void> {
  await db.prepare(`DELETE FROM accounts WHERE ig_user_id = ?`).bind(igUserId).run();
}

/* ---------------------------------------------------------------- settings */

/**
 * Remembers the hostname this instance answers on.
 *
 * The cron has no request to read it from, and a recovered DM has to carry the
 * same tracked-link host a webhook-driven one would.
 */
export async function rememberHost(db: D1Database, host: string): Promise<void> {
  if (!host) return;
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('public_host', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(host, Date.now())
    .run();
}

export async function knownHost(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE key = 'public_host'`)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Where the last reconcile run stopped in the account list.
 *
 * Reconciliation processes a bounded slice of accounts per run; without a cursor
 * it would always start from the same end of the username ordering and never
 * reach the tail. Read defensively — anything non-numeric restarts from zero.
 */
export async function getReconcileCursor(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE key = 'reconcile_cursor'`)
    .first<{ value: string }>();
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function setReconcileCursor(db: D1Database, cursor: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('reconcile_cursor', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(String(cursor), Date.now())
    .run();
}

/* ------------------------------------------------------- prospect threads */

export type ProspectState = "m1_pendiente" | "m1_sin_confirmar" | "enrolled" | "closed";

export interface ProspectThread {
  leadId: string;
  igUserId: string;
  igsid: string | null;
  handle: string;
  state: ProspectState;
  m1Sha: string | null;
  version: number;
}

interface ProspectThreadRow {
  lead_id: string;
  ig_user_id: string;
  igsid: string | null;
  handle: string;
  state: string;
  m1_sha: string | null;
  version: number;
}

const toProspectThread = (r: ProspectThreadRow): ProspectThread => ({
  leadId: r.lead_id,
  igUserId: r.ig_user_id,
  igsid: r.igsid,
  handle: r.handle,
  state: r.state as ProspectState,
  m1Sha: r.m1_sha,
  version: r.version,
});

/**
 * Pending threads whose expected M1 has exactly this normalized hash.
 *
 * The caller must require exactly one. More than one means the same text was
 * copied for two leads, and choosing either would be a guess about identity.
 */
export async function pendingM1Threads(
  db: D1Database,
  igUserId: string,
  m1Sha: string,
): Promise<ProspectThread[]> {
  const { results } = await db
    .prepare(
      `SELECT lead_id, ig_user_id, igsid, handle, state, m1_sha, version
       FROM prospect_threads
       WHERE ig_user_id = ? AND state = 'm1_pendiente'
         AND igsid IS NULL AND m1_sha = ?
       ORDER BY lead_id`,
    )
    .bind(igUserId, m1Sha)
    .all<ProspectThreadRow>();

  return results.map(toProspectThread);
}

/** The enrolled thread a peer id belongs to on this account, if any. */
export async function enrolledThreadByIgsid(
  db: D1Database,
  igUserId: string,
  igsid: string,
): Promise<ProspectThread | null> {
  const row = await db
    .prepare(
      `SELECT lead_id, ig_user_id, igsid, handle, state, m1_sha, version
       FROM prospect_threads
       WHERE ig_user_id = ? AND igsid = ? AND state = 'enrolled'`,
    )
    .bind(igUserId, igsid)
    .first<ProspectThreadRow>();

  return row ? toProspectThread(row) : null;
}

/**
 * Enrolls the matched pending thread and stores the M1 echo as one step.
 *
 * The update is conditioned on the state and version read before it, so a
 * duplicate delivery cannot enroll twice or bump the conversation version twice.
 * The message insert only fires if that update won the race, and `mid` dedupes a
 * redelivery even then.
 */
export async function enrollProspectThread(
  db: D1Database,
  t: {
    leadId: string;
    igUserId: string;
    igsid: string;
    mid: string;
    text: string;
    sentAt: number;
    expectedVersion: number;
  },
): Promise<boolean> {
  const now = Date.now();
  const nextVersion = t.expectedVersion + 1;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE prospect_threads
         SET igsid = ?, state = 'enrolled', version = version + 1,
             last_outbound_at = ?, enrolled_at = ?, updated_at = ?
         WHERE lead_id = ? AND ig_user_id = ? AND state = 'm1_pendiente'
           AND igsid IS NULL AND version = ?`,
      )
      // `enrolled_at` is the echo's own timestamp, which is when the operator
      // sent the M1 — the moment the follow-up days count from (T19).
      .bind(t.igsid, t.sentAt, t.sentAt, now, t.leadId, t.igUserId, t.expectedVersion),
    db
      .prepare(
        `INSERT OR IGNORE INTO prospect_messages
           (mid, lead_id, direction, origin, text, sent_at, created_at)
         SELECT ?, ?, 'out', 'echo_m1', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM prospect_threads
           WHERE lead_id = ? AND ig_user_id = ? AND state = 'enrolled'
             AND igsid = ? AND version = ?
         )`,
      )
      .bind(
        t.mid,
        t.leadId,
        t.text,
        t.sentAt,
        now,
        t.leadId,
        t.igUserId,
        t.igsid,
        nextVersion,
      ),
  ]);

  return (results[0]?.meta.changes ?? 0) > 0;
}

/**
 * Stores one inbound message and advances the thread version, once per `mid`.
 *
 * The NOT EXISTS clause keeps the version from moving on a redelivery even
 * before the insert reaches its own unique key.
 */
export async function recordProspectInbound(
  db: D1Database,
  t: {
    leadId: string;
    igUserId: string;
    igsid: string;
    mid: string;
    text: string;
    sentAt: number;
  },
): Promise<boolean> {
  const now = Date.now();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE prospect_threads
         SET version = version + 1, last_inbound_at = ?, updated_at = ?
         WHERE lead_id = ? AND ig_user_id = ? AND state = 'enrolled' AND igsid = ?
           AND NOT EXISTS (SELECT 1 FROM prospect_messages WHERE mid = ?)`,
      )
      .bind(t.sentAt, now, t.leadId, t.igUserId, t.igsid, t.mid),
    db
      .prepare(
        `INSERT OR IGNORE INTO prospect_messages
           (mid, lead_id, direction, origin, text, sent_at, created_at)
         SELECT ?, ?, 'in', 'webhook', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM prospect_threads
           WHERE lead_id = ? AND ig_user_id = ? AND state = 'enrolled' AND igsid = ?
         )`,
      )
      .bind(t.mid, t.leadId, t.text, t.sentAt, now, t.leadId, t.igUserId, t.igsid),
  ]);

  return (results[0]?.meta.changes ?? 0) > 0;
}

/**
 * Stores a message the operator typed on his phone and freezes the conversation
 * around it.
 *
 * An echo on an enrolled thread whose `mid` is not one of our recorded sends is
 * the account talking to a lead we already know — the only way a message written
 * by hand is visible to the Worker at all. Advancing the version is what tells
 * every draft it was written against a conversation that has moved on, and the
 * drafts are retired in the same transaction: a reply written before this
 * message must be redrafted, not sent as if it answered it.
 *
 * The `NOT EXISTS` guard is by `mid`, so a redelivery writes nothing at all. It
 * is checked before the insert below rather than after, because statements in a
 * batch run in order.
 */
export async function recordProspectOwnerMessage(
  db: D1Database,
  t: {
    leadId: string;
    igUserId: string;
    igsid: string;
    mid: string;
    text: string;
    sentAt: number;
  },
): Promise<boolean> {
  const now = Date.now();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE prospect_threads
         SET version = version + 1, last_outbound_at = ?, updated_at = ?
         WHERE lead_id = ? AND ig_user_id = ? AND state = 'enrolled' AND igsid = ?
           AND NOT EXISTS (SELECT 1 FROM prospect_messages WHERE mid = ?)`,
      )
      .bind(t.sentAt, now, t.leadId, t.igUserId, t.igsid, t.mid),
    db
      .prepare(
        `UPDATE prospect_drafts SET status = 'invalidated'
         WHERE lead_id = ? AND status IN ('waiting', 'approved')
           AND NOT EXISTS (SELECT 1 FROM prospect_messages WHERE mid = ?)`,
      )
      .bind(t.leadId, t.mid),
    db
      .prepare(
        `INSERT OR IGNORE INTO prospect_messages
           (mid, lead_id, direction, origin, text, sent_at, created_at)
         SELECT ?, ?, 'out', 'owner', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM prospect_threads
           WHERE lead_id = ? AND ig_user_id = ? AND state = 'enrolled' AND igsid = ?
         )`,
      )
      .bind(t.mid, t.leadId, t.text, t.sentAt, now, t.leadId, t.igUserId, t.igsid),
  ]);

  return (results[0]?.meta.changes ?? 0) > 0;
}

/* ------------------------------------------------------- prospect API rows */

/**
 * A thread as the JSON API reports it. `igsid` is deliberately absent: it is
 * how the webhook recognises a lead, not something a client has any use for.
 */
export interface ProspectThreadDetail {
  leadId: string;
  igUserId: string;
  igsid: string | null;
  handle: string;
  name: string | null;
  nicho: string | null;
  state: ProspectState;
  m1Sha: string | null;
  m1RegisteredAt: number | null;
  version: number;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  /** The M1 echo's timestamp — when the thread enrolled, and what the
   *  follow-up days count from. Null until that echo arrives. */
  enrolledAt: number | null;
  /** "Hecho" on the follow-up queue's touch step (T19). */
  touchDoneAt: number | null;
  /** "Enviado" on the follow-up queue's DM step (T19). */
  followupSentAt: number | null;
  /** `no_reply` when the scheduled job closed it; null for every other close. */
  closeReason: string | null;
  /** JSON text of the profile read (T14). Never an id Meta gave us (L12). */
  profileSummary: string | null;
  /** When that profile was read; the gate's `profile_read` evidence. */
  profileReadAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ProspectThreadDetailRow {
  lead_id: string;
  ig_user_id: string;
  igsid: string | null;
  handle: string;
  name: string | null;
  nicho: string | null;
  state: string;
  m1_sha: string | null;
  m1_registered_at: number | null;
  version: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  enrolled_at: number | null;
  touch_done_at: number | null;
  followup_sent_at: number | null;
  close_reason: string | null;
  profile_summary: string | null;
  profile_read_at: number | null;
  created_at: number;
  updated_at: number;
}

const PROSPECT_THREAD_COLUMNS = `lead_id, ig_user_id, igsid, handle, name, nicho, state, m1_sha,
         m1_registered_at, version, last_inbound_at, last_outbound_at, enrolled_at,
         touch_done_at, followup_sent_at, close_reason, profile_summary, profile_read_at,
         created_at, updated_at`;

const toProspectThreadDetail = (r: ProspectThreadDetailRow): ProspectThreadDetail => ({
  leadId: r.lead_id,
  igUserId: r.ig_user_id,
  igsid: r.igsid,
  handle: r.handle,
  name: r.name,
  nicho: r.nicho,
  state: r.state as ProspectState,
  m1Sha: r.m1_sha,
  m1RegisteredAt: r.m1_registered_at,
  version: r.version,
  lastInboundAt: r.last_inbound_at,
  lastOutboundAt: r.last_outbound_at,
  enrolledAt: r.enrolled_at,
  touchDoneAt: r.touch_done_at,
  followupSentAt: r.followup_sent_at,
  closeReason: r.close_reason,
  profileSummary: r.profile_summary,
  profileReadAt: r.profile_read_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type ProspectDraftKind = "m1" | "reply";
export type ProspectDraftStatus =
  | "waiting"
  | "approved"
  | "invalidated"
  | "skipped"
  | "sent"
  | "expired"
  | "send_state_unknown";

export interface ProspectDraft {
  draftId: string;
  leadId: string;
  kind: ProspectDraftKind;
  stage: string | null;
  text: string;
  baseVersion: number;
  /** The M1 variant this draft was written under (L25); replies have none. */
  variantId: string | null;
  status: ProspectDraftStatus;
  decidedAt: number | null;
  decidedText: string | null;
  createdAt: number;
}

interface ProspectDraftRow {
  draft_id: string;
  lead_id: string;
  kind: string;
  stage: string | null;
  text: string;
  base_version: number;
  variant_id?: string | null;
  status: string;
  decided_at: number | null;
  decided_text: string | null;
  created_at: number;
}

/** One list, used by every read: a dropped column would read as `undefined`, not as an error. */
const PROSPECT_DRAFT_COLUMNS = `draft_id, lead_id, kind, stage, text, base_version, variant_id, status,
         decided_at, decided_text, created_at`;

const toProspectDraft = (r: ProspectDraftRow): ProspectDraft => ({
  draftId: r.draft_id,
  leadId: r.lead_id,
  kind: r.kind as ProspectDraftKind,
  stage: r.stage,
  text: r.text,
  baseVersion: r.base_version,
  variantId: r.variant_id ?? null,
  status: r.status as ProspectDraftStatus,
  decidedAt: r.decided_at,
  decidedText: r.decided_text,
  createdAt: r.created_at,
});

export interface ProspectMessage {
  mid: string;
  leadId: string;
  direction: "in" | "out";
  origin: string;
  text: string;
  sentAt: number;
  draftedAt: number | null;
  answeredAt: number | null;
}

interface ProspectMessageRow {
  mid: string;
  lead_id: string;
  direction: string;
  origin: string;
  text: string;
  sent_at: number;
  drafted_at: number | null;
  answered_at: number | null;
}

const toProspectMessage = (r: ProspectMessageRow): ProspectMessage => ({
  mid: r.mid,
  leadId: r.lead_id,
  direction: r.direction === "in" ? "in" : "out",
  origin: r.origin,
  text: r.text,
  sentAt: r.sent_at,
  draftedAt: r.drafted_at,
  answeredAt: r.answered_at,
});

export interface ProspectAuthorization {
  draftId: string;
  category: string;
  gateReason: string;
  expiresAt: number;
  createdAt: number;
}

export async function getProspectThread(
  db: D1Database,
  leadId: string,
): Promise<ProspectThreadDetail | null> {
  const row = await db
    .prepare(`SELECT ${PROSPECT_THREAD_COLUMNS} FROM prospect_threads WHERE lead_id = ?`)
    .bind(leadId)
    .first<ProspectThreadDetailRow>();

  return row ? toProspectThreadDetail(row) : null;
}

/**
 * Creates or refreshes a thread from the Sheet's columns.
 *
 * The conflict branch only touches what the Sheet owns. Enrollment, the M1 hash
 * and the conversation version belong to the webhook, and a Sheet resync must
 * never roll them back.
 */
export async function upsertProspectThread(
  db: D1Database,
  t: {
    leadId: string;
    igUserId: string;
    handle: string;
    name: string | null;
    nicho: string | null;
    /** Profile evidence to record with this refresh; the stored one is kept otherwise. */
    profile?: { summary: string; readAt: number } | null;
  },
): Promise<ProspectThreadDetail> {
  const now = Date.now();
  const profileSummary = t.profile?.summary ?? null;
  const profileReadAt = t.profile?.readAt ?? null;
  await db
    .prepare(
      `INSERT INTO prospect_threads
         (lead_id, ig_user_id, igsid, handle, name, nicho, state, m1_sha, m1_registered_at,
          version, last_inbound_at, last_outbound_at, profile_summary, profile_read_at,
          created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'm1_pendiente', NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT (lead_id) DO UPDATE SET
         handle = excluded.handle,
         name = excluded.name,
         nicho = excluded.nicho,
         -- Evidence a reply depends on is only ever added: a Sheet resync that
         -- says nothing about the profile must not erase a read that happened.
         profile_summary = COALESCE(excluded.profile_summary, profile_summary),
         profile_read_at = COALESCE(excluded.profile_read_at, profile_read_at),
         updated_at = excluded.updated_at`,
    )
    .bind(
      t.leadId,
      t.igUserId,
      t.handle,
      t.name,
      t.nicho,
      profileSummary,
      profileReadAt,
      now,
      now,
    )
    .run();

  const thread = await getProspectThread(db, t.leadId);
  if (!thread) throw new Error(`prospect thread ${t.leadId} vanished after upsert`);
  return thread;
}

/**
 * Records the text whose echo enrolls the thread.
 *
 * Any earlier pending text is replaced, which is what the "M1 sin confirmar"
 * retry does. The text itself is kept beside its hash: the page that the copy
 * answers with has to render it and hand it back to the clipboard, and the
 * draft it was edited from is not the same text. A thread that already has an
 * igsid is enrolled and cannot be re-armed; the caller reports that as
 * `already_enrolled`.
 */
export async function registerProspectM1(
  db: D1Database,
  t: { leadId: string; m1Sha: string; text: string },
): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE prospect_threads
       SET m1_sha = ?, m1_copied_text = ?, m1_registered_at = ?,
           state = 'm1_pendiente', updated_at = ?
       WHERE lead_id = ? AND igsid IS NULL AND state != 'closed'`,
    )
    .bind(t.m1Sha, t.text, now, now, t.leadId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * What "Copiar" registered for this thread: the notice the copy re-renders.
 *
 * Read by the page only, from the lead id the redirect names. A thread that was
 * never copied has nothing to show, so a hand-written `?copied=` renders no
 * notice rather than an empty one.
 */
export async function prospectCopiedM1(
  db: D1Database,
  leadId: string,
): Promise<{ leadId: string; handle: string; name: string | null; text: string } | null> {
  if (leadId === "") return null;

  const row = await db
    .prepare(
      `SELECT lead_id, handle, name, m1_copied_text FROM prospect_threads
       WHERE lead_id = ? AND m1_copied_text IS NOT NULL`,
    )
    .bind(leadId)
    .first<{ lead_id: string; handle: string; name: string | null; m1_copied_text: string }>();

  return row
    ? { leadId: row.lead_id, handle: row.handle, name: row.name, text: row.m1_copied_text }
    : null;
}

export async function getProspectDraft(
  db: D1Database,
  draftId: string,
): Promise<ProspectDraft | null> {
  const row = await db
    .prepare(`SELECT * FROM prospect_drafts WHERE draft_id = ?`)
    .bind(draftId)
    .first<ProspectDraftRow>();

  return row ? toProspectDraft(row) : null;
}

/** One row per `draft_id`; false means it was already there. */
export async function insertProspectDraft(
  db: D1Database,
  d: ProspectDraft,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO prospect_drafts
         (draft_id, lead_id, kind, stage, text, base_version, variant_id, status, decided_at,
          decided_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      d.draftId,
      d.leadId,
      d.kind,
      d.stage,
      d.text,
      d.baseVersion,
      d.variantId,
      d.status,
      d.decidedAt,
      d.decidedText,
      d.createdAt,
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Records the CLI's gate answer for one (draft, category).
 *
 * Upsert, not insert: the Pi is stateless and re-runs its `authorize` phase on
 * every pass, so an insert would add a row per pass and export a growing pile
 * that says nothing new. `created_at` is the moment autonomy was granted, and
 * the cron's human delay counts from it (`prospectAutopilotDueAt`); re-recording
 * the same grant keeps it, because restamping would push the send another three
 * to twelve minutes away on every pass and it would never become due. A row that
 * turns a refusal into a grant starts the clock now: there was no permission
 * before this pass, so there is no earlier moment to count from.
 */
export async function upsertProspectAuthorization(
  db: D1Database,
  a: ProspectAuthorization,
): Promise<{ created: boolean; authorization: ProspectAuthorization }> {
  const updated = await db
    .prepare(
      `UPDATE prospect_authorizations
       SET gate_reason = ?, expires_at = ?,
           created_at = CASE WHEN gate_reason = '' AND ? = '' THEN created_at ELSE ? END
       WHERE draft_id = ? AND category = ?`,
    )
    .bind(a.gateReason, a.expiresAt, a.gateReason, a.createdAt, a.draftId, a.category)
    .run();

  const created = (updated.meta.changes ?? 0) === 0;
  if (created) {
    await db
      .prepare(
        `INSERT INTO prospect_authorizations
           (draft_id, category, gate_reason, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(a.draftId, a.category, a.gateReason, a.expiresAt, a.createdAt)
      .run();
  }

  const row = await db
    .prepare(
      `SELECT draft_id, category, gate_reason, expires_at, created_at
       FROM prospect_authorizations
       WHERE draft_id = ? AND category = ?
       ORDER BY expires_at DESC, created_at DESC LIMIT 1`,
    )
    .bind(a.draftId, a.category)
    .first<ProspectAuthorizationRow>();
  if (!row) throw new Error(`prospect authorization ${a.draftId}/${a.category} vanished after upsert`);

  return { created, authorization: toProspectAuthorization(row) };
}

interface ProspectAuthorizationRow {
  draft_id: string;
  category: string;
  gate_reason: string;
  expires_at: number;
  created_at: number;
}

const toProspectAuthorization = (r: ProspectAuthorizationRow): ProspectAuthorization => ({
  draftId: r.draft_id,
  category: r.category,
  gateReason: r.gate_reason,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

/**
 * The authorizations that still stand for these drafts, for the CLI's export.
 *
 * Only rows inside their expiry: an expired one is history, and the CLI re-runs
 * the gate on every pass rather than reading old answers. A refused row is
 * included — it is current, its `gate_reason` is not empty, and the Worker never
 * reads one as permission.
 */
export async function prospectAuthorizationsFor(
  db: D1Database,
  draftIds: readonly string[],
  now = Date.now(),
): Promise<ProspectAuthorization[]> {
  const authorizations: ProspectAuthorization[] = [];

  for (const ids of chunk(draftIds)) {
    const { results } = await db
      .prepare(
        `SELECT draft_id, category, gate_reason, expires_at, created_at
         FROM prospect_authorizations
         WHERE expires_at > ? AND draft_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY draft_id ASC, category ASC`,
      )
      .bind(now, ...ids)
      .all<ProspectAuthorizationRow>();
    authorizations.push(...results.map(toProspectAuthorization));
  }

  return authorizations;
}

/**
 * The autopilot permission that covers this draft right now, if any.
 *
 * A row whose gate refused (a non-empty `gate_reason`) is not permission: the
 * CLI records what the gate answered, and the Worker obeys it either way. The
 * newest still-valid row wins, so re-authorizing extends rather than conflicts.
 */
export async function currentProspectAuthorization(
  db: D1Database,
  draftId: string,
  now = Date.now(),
): Promise<ProspectAuthorization | null> {
  const row = await db
    .prepare(
      `SELECT draft_id, category, gate_reason, expires_at, created_at
       FROM prospect_authorizations
       WHERE draft_id = ? AND gate_reason = '' AND expires_at > ?
       ORDER BY expires_at DESC LIMIT 1`,
    )
    .bind(draftId, now)
    .first<ProspectAuthorizationRow>();

  return row
    ? {
        draftId: row.draft_id,
        category: row.category,
        gateReason: row.gate_reason,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      }
    : null;
}

/* ------------------------------------------------------- prospect sending */

/**
 * The thread's last message in either direction — whose turn it is.
 *
 * An API reply only makes sense while the lead has the last word: answering our
 * own last message is not a reply, and Meta refuses it anyway.
 */
export async function latestProspectMessage(
  db: D1Database,
  leadId: string,
): Promise<ProspectMessage | null> {
  const row = await db
    .prepare(
      `SELECT mid, lead_id, direction, origin, text, sent_at, drafted_at, answered_at
       FROM prospect_messages WHERE lead_id = ?
       ORDER BY sent_at DESC, mid DESC LIMIT 1`,
    )
    .bind(leadId)
    .first<ProspectMessageRow>();

  return row ? toProspectMessage(row) : null;
}

/**
 * Whether this idempotency key is already spent on this thread.
 *
 * `idem` is our own key for an API send — the draft id — and the unique index on
 * `(lead_id, idem)` makes it binding even if two writers race.
 */
export async function prospectMessageByIdem(
  db: D1Database,
  leadId: string,
  idem: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS found FROM prospect_messages WHERE lead_id = ? AND idem = ?`)
    .bind(leadId, idem)
    .first<{ found: number }>();

  return row !== null;
}

/** Whether Meta's id for this message is already stored. */
export async function prospectMessageExists(db: D1Database, mid: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS found FROM prospect_messages WHERE mid = ?`)
    .bind(mid)
    .first<{ found: number }>();

  return row !== null;
}

/**
 * Stores a confirmed API reply and settles the conversation around it.
 *
 * The writes belong together: the message itself, the version it moves, the
 * inbound it answers, and the draft it came from. The message keeps the `mid`
 * Meta returned, which is what tells T8's echo handler that the copy arriving on
 * the webhook is our own send and not a message the operator typed on his phone.
 */
export async function recordProspectSent(
  db: D1Database,
  s: {
    mid: string;
    leadId: string;
    igUserId: string;
    igsid: string;
    draftId: string;
    text: string;
    sentAt: number;
    /** The lead's message this reply answers, if the checks found one. */
    inboundMid: string | null;
  },
): Promise<void> {
  const statements = [
    db
      .prepare(
        `UPDATE prospect_threads
         SET version = version + 1, last_outbound_at = ?, updated_at = ?
         WHERE lead_id = ? AND ig_user_id = ? AND state = 'enrolled' AND igsid = ?`,
      )
      .bind(s.sentAt, s.sentAt, s.leadId, s.igUserId, s.igsid),
    db
      .prepare(
        `INSERT OR IGNORE INTO prospect_messages
           (mid, lead_id, direction, origin, text, sent_at, idem, created_at)
         VALUES (?, ?, 'out', 'api', ?, ?, ?, ?)`,
      )
      .bind(s.mid, s.leadId, s.text, s.sentAt, s.draftId, s.sentAt),
    db
      .prepare(
        `UPDATE prospect_drafts SET status = 'sent'
         WHERE draft_id = ? AND status IN ('approved', 'waiting')`,
      )
      .bind(s.draftId),
  ];
  if (s.inboundMid !== null) {
    statements.push(
      db
        .prepare(
          `UPDATE prospect_messages SET answered_at = ?
           WHERE mid = ? AND lead_id = ? AND direction = 'in'`,
        )
        .bind(s.sentAt, s.inboundMid, s.leadId),
    );
  }

  await db.batch(statements);
}

/* ------------------------------------------------- goals for the mobile page */

/**
 * A registered M1 with no echo after this long is shown as unconfirmed.
 *
 * Copying and sending are seconds apart on a phone, and the echo lands right
 * after the send, so half an hour is already generous. The state is derived, not
 * written: rendering the page never touches D1.
 */
export const M1_UNCONFIRMED_AFTER_MS = 30 * 60 * 1000;

/** Meta stops letting the API answer a lead 24 h after their last message. */
export const MESSAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** From here the page flags the draft, so a slow session still has time left. */
export const WINDOW_WARNING_MS = 20 * 60 * 60 * 1000;

/** A thread waiting for its first DM, with the CLI's draft as the starting text. */
export interface ProspectM1Item {
  thread: ProspectThreadDetail;
  /** The latest `m1` draft, or null when the CLI has not drafted one yet. */
  text: string | null;
}

/**
 * The latest M1 draft of a thread: the one its editable box shows and the one
 * whose push order decides where the thread sits in the send queue.
 *
 * Oldest batch first. A thread the CLI drafted twice belongs to the later push,
 * because that is the text a person would copy now.
 */
const M1_DRAFT_ORDER = `(
  SELECT d.created_at FROM prospect_drafts d
   WHERE d.lead_id = prospect_threads.lead_id AND d.kind = 'm1'
   ORDER BY d.created_at DESC, d.draft_id DESC LIMIT 1)`;

const M1_DRAFT_ID = `(
  SELECT d.draft_id FROM prospect_drafts d
   WHERE d.lead_id = prospect_threads.lead_id AND d.kind = 'm1'
   ORDER BY d.created_at DESC, d.draft_id DESC LIMIT 1)`;

/**
 * The M1 queues: what is still uncopied, what was copied and is waiting for its
 * echo, and what was copied so long ago that the echo is not coming.
 *
 * "M1 por enviar" only holds threads never copied (`m1_registered_at IS NULL`),
 * in the order their latest M1 draft was pushed. A copied thread used to stay on
 * top for thirty minutes, which put the same person in front of the operator
 * again and again; it now moves out of the queue immediately and into the
 * collapsed "Copiados, esperando confirmación" section. After
 * `M1_UNCONFIRMED_AFTER_MS` it joins "M1 sin confirmar", where the only way
 * forward is copying it again.
 */
export async function prospectM1Queue(
  db: D1Database,
  now = Date.now(),
): Promise<{
  pending: ProspectM1Item[];
  copied: ProspectM1Item[];
  unconfirmed: ProspectM1Item[];
}> {
  const cutoff = now - M1_UNCONFIRMED_AFTER_MS;
  const [pendingRows, copiedRows, unconfirmedRows] = await Promise.all([
    db
      .prepare(
        `SELECT ${PROSPECT_THREAD_COLUMNS} FROM prospect_threads
         WHERE state = 'm1_pendiente' AND m1_registered_at IS NULL
         ORDER BY ${M1_DRAFT_ORDER} IS NULL ASC,
                  ${M1_DRAFT_ORDER} ASC,
                  ${M1_DRAFT_ID} ASC,
                  created_at ASC, lead_id ASC`,
      )
      .all<ProspectThreadDetailRow>(),
    // Copied, but the echo is still allowed to be in flight. This is the section
    // that used to be the top of the send queue.
    db
      .prepare(
        `SELECT ${PROSPECT_THREAD_COLUMNS} FROM prospect_threads
         WHERE state = 'm1_pendiente' AND m1_registered_at IS NOT NULL
           AND m1_registered_at > ?
         ORDER BY m1_registered_at ASC, lead_id ASC`,
      )
      .bind(cutoff)
      .all<ProspectThreadDetailRow>(),
    // `m1_sin_confirmar` is written when the same text was pending on two leads;
    // the time branch is the copy whose echo never came back.
    db
      .prepare(
        `SELECT ${PROSPECT_THREAD_COLUMNS} FROM prospect_threads
         WHERE state = 'm1_sin_confirmar'
            OR (state = 'm1_pendiente' AND m1_registered_at IS NOT NULL
                AND m1_registered_at <= ?)
         ORDER BY COALESCE(m1_registered_at, created_at) ASC, lead_id ASC`,
      )
      .bind(cutoff)
      .all<ProspectThreadDetailRow>(),
  ]);

  const pending = pendingRows.results.map(toProspectThreadDetail);
  const copied = copiedRows.results.map(toProspectThreadDetail);
  const unconfirmed = unconfirmedRows.results.map(toProspectThreadDetail);
  const texts = await latestM1Texts(
    db,
    [...pending, ...copied, ...unconfirmed].map((t) => t.leadId),
  );
  const withText = (t: ProspectThreadDetail): ProspectM1Item => ({
    thread: t,
    text: texts.get(t.leadId) ?? null,
  });

  return {
    pending: pending.map(withText),
    copied: copied.map(withText),
    unconfirmed: unconfirmed.map(withText),
  };
}

/** The CLI's latest M1 draft per lead — the starting point of the editable box. */
async function latestM1Texts(
  db: D1Database,
  leadIds: readonly string[],
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const ids of chunk(leadIds)) {
    const { results } = await db
      .prepare(
        `SELECT ${PROSPECT_DRAFT_COLUMNS}
         FROM prospect_drafts
         WHERE kind = 'm1' AND lead_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY created_at ASC, draft_id ASC`,
      )
      .bind(...ids)
      .all<ProspectDraftRow>();
    // Oldest first, so the last write for a lead is the draft it should show.
    for (const row of results) texts.set(row.lead_id, row.text);
  }
  return texts;
}

/** A reply draft with the thread it belongs to and the lead's latest message. */
export interface ProspectQueueItem {
  thread: ProspectThreadDetail;
  draft: ProspectDraft;
  inbound: ProspectMessage | null;
}

/**
 * Reply drafts waiting for the operator's OK, oldest wait first.
 *
 * Only threads still inside the 24 h window: a draft past it cannot be answered
 * by the API, so it belongs in the manual queue rather than here.
 */
export async function prospectDraftQueue(
  db: D1Database,
  now = Date.now(),
): Promise<ProspectQueueItem[]> {
  const cutoff = now - MESSAGE_WINDOW_MS;
  const items = await replyDraftItems(db, ["waiting"]);

  return items
    .filter(
      (i) =>
        i.thread.state === "enrolled" &&
        i.thread.lastInboundAt !== null &&
        i.thread.lastInboundAt > cutoff,
    )
    .sort((a, b) => (a.thread.lastInboundAt ?? 0) - (b.thread.lastInboundAt ?? 0));
}

/**
 * What a person has to do by hand: the window is closed, or a send was cut off
 * with no way to know whether it arrived.
 *
 * `send_state_unknown` is never retried automatically — retrying would risk two
 * messages — so a person looks at the thread and says which happened.
 */
export interface ProspectManualItem extends ProspectQueueItem {
  reason: "window_closed" | "send_state_unknown";
}

export async function prospectManualQueue(
  db: D1Database,
  now = Date.now(),
): Promise<ProspectManualItem[]> {
  const cutoff = now - MESSAGE_WINDOW_MS;
  const items = await replyDraftItems(db, ["waiting", "send_state_unknown"]);
  const manual: ProspectManualItem[] = [];

  for (const item of items) {
    // A closed thread is never sent to again, so it has no manual work either.
    if (item.thread.state === "closed") continue;
    if (item.draft.status === "send_state_unknown") {
      manual.push({ ...item, reason: "send_state_unknown" });
      continue;
    }
    const { thread } = item;
    const open =
      thread.state === "enrolled" &&
      thread.lastInboundAt !== null &&
      thread.lastInboundAt > cutoff;
    if (!open) manual.push({ ...item, reason: "window_closed" });
  }

  return manual.sort(
    (a, b) =>
      (a.thread.lastInboundAt ?? a.draft.createdAt) -
      (b.thread.lastInboundAt ?? b.draft.createdAt),
  );
}

/** Reply drafts in the given statuses, with their thread and latest inbound. */
async function replyDraftItems(
  db: D1Database,
  statuses: readonly ProspectDraftStatus[],
): Promise<ProspectQueueItem[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PROSPECT_DRAFT_COLUMNS}
       FROM prospect_drafts
       WHERE kind = 'reply' AND status IN (${statuses.map(() => "?").join(", ")})
       ORDER BY created_at ASC, draft_id ASC`,
    )
    .bind(...statuses)
    .all<ProspectDraftRow>();

  const drafts = results.map(toProspectDraft);
  if (drafts.length === 0) return [];

  const leadIds = [...new Set(drafts.map((d) => d.leadId))];
  const threads = new Map((await prospectThreadsByIds(db, leadIds)).map((t) => [t.leadId, t]));
  const inbound = await latestInboundMessages(db, leadIds);

  return drafts.flatMap((draft) => {
    const thread = threads.get(draft.leadId);
    // A draft whose thread is gone has nothing to show; the foreign key already
    // means it cannot happen, and a page is the wrong place to find out.
    if (!thread) return [];
    return [{ thread, draft, inbound: inbound.get(draft.leadId) ?? null }];
  });
}

async function prospectThreadsByIds(
  db: D1Database,
  leadIds: readonly string[],
): Promise<ProspectThreadDetail[]> {
  const threads: ProspectThreadDetail[] = [];
  for (const ids of chunk(leadIds)) {
    const { results } = await db
      .prepare(
        `SELECT ${PROSPECT_THREAD_COLUMNS} FROM prospect_threads
         WHERE lead_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .bind(...ids)
      .all<ProspectThreadDetailRow>();
    threads.push(...results.map(toProspectThreadDetail));
  }
  return threads;
}

/** Each thread's latest inbound message — what the reply is answering. */
async function latestInboundMessages(
  db: D1Database,
  leadIds: readonly string[],
): Promise<Map<string, ProspectMessage>> {
  const latest = new Map<string, ProspectMessage>();
  for (const ids of chunk(leadIds)) {
    const { results } = await db
      .prepare(
        `SELECT mid, lead_id, direction, origin, text, sent_at, drafted_at, answered_at
         FROM prospect_messages
         WHERE direction = 'in' AND lead_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY sent_at ASC, mid ASC`,
      )
      .bind(...ids)
      .all<ProspectMessageRow>();
    for (const row of results) latest.set(row.lead_id, toProspectMessage(row));
  }
  return latest;
}

/**
 * The ambiguous echo of T4's design: the same copied text was pending on two
 * leads, so which one received it is unknowable. Neither enrolls; both come back
 * to the operator with a retry.
 */
export async function markAmbiguousM1Threads(
  db: D1Database,
  igUserId: string,
  m1Sha: string,
  now = Date.now(),
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE prospect_threads SET state = 'm1_sin_confirmar', updated_at = ?
       WHERE ig_user_id = ? AND state = 'm1_pendiente' AND igsid IS NULL AND m1_sha = ?`,
    )
    .bind(now, igUserId, m1Sha)
    .run();

  return result.meta.changes ?? 0;
}

/**
 * "Reintentar" on an unconfirmed M1: back to the send queue with nothing
 * registered, because the hash it had points at a text nobody sent.
 */
export async function retryProspectM1(
  db: D1Database,
  leadId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE prospect_threads
       SET state = 'm1_pendiente', m1_sha = NULL, m1_copied_text = NULL,
           m1_registered_at = NULL, updated_at = ?
       WHERE lead_id = ? AND igsid IS NULL
         AND state IN ('m1_pendiente', 'm1_sin_confirmar')`,
    )
    .bind(now, leadId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** Why a person closed a thread. `no_reply` is the one the cron also writes. */
export const PROSPECT_CLOSE_REASONS = [
  "no_interesa",
  "fuera_de_nicho",
  "no_reply",
  "otro",
] as const;

export type ProspectCloseReason = (typeof PROSPECT_CLOSE_REASONS)[number];

export function isProspectCloseReason(value: string): value is ProspectCloseReason {
  return (PROSPECT_CLOSE_REASONS as readonly string[]).includes(value);
}

export type ProspectCloseOutcome =
  | { ok: true; closed: boolean; thread: ProspectThreadDetail }
  | { ok: false; error: "not_found" | "thread_closed" };

/**
 * Closes a thread by hand and retires every draft that was still sendable.
 *
 * Valid for any open state: `m1_pendiente` (copied or not), `m1_sin_confirmar`
 * and `enrolled`. The close is permanent — the thread can never be re-armed — so
 * a repeated request with the same reason answers `closed: false` and writes
 * nothing, while a different reason is a conflict rather than a silent rewrite
 * of why somebody is not to be contacted. Pending drafts are invalidated in the
 * same batch: a message written before the close must not be sendable after it.
 */
export async function closeProspectThread(
  db: D1Database,
  c: { leadId: string; reason: ProspectCloseReason; now?: number },
): Promise<ProspectCloseOutcome> {
  const existing = await getProspectThread(db, c.leadId);
  if (!existing) return { ok: false, error: "not_found" };

  if (existing.state === "closed") {
    if (existing.closeReason !== c.reason) return { ok: false, error: "thread_closed" };
    // A close that raced an earlier one may have left a draft behind; the
    // invariant "a closed thread has nothing sendable" is restored here.
    await invalidateProspectDrafts(db, c.leadId);
    return { ok: true, closed: false, thread: existing };
  }

  const now = c.now ?? Date.now();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE prospect_threads SET state = 'closed', close_reason = ?, updated_at = ?
         WHERE lead_id = ? AND state != 'closed'`,
      )
      .bind(c.reason, now, c.leadId),
    db
      .prepare(
        `UPDATE prospect_drafts SET status = 'invalidated'
         WHERE lead_id = ? AND status IN ('waiting', 'approved')`,
      )
      .bind(c.leadId),
  ]);

  if ((results[0]?.meta.changes ?? 0) === 0) {
    const raced = await getProspectThread(db, c.leadId);
    if (!raced) return { ok: false, error: "not_found" };
    if (raced.state === "closed" && raced.closeReason === c.reason) {
      return { ok: true, closed: false, thread: raced };
    }
    return { ok: false, error: "thread_closed" };
  }

  const thread = await getProspectThread(db, c.leadId);
  if (!thread) return { ok: false, error: "not_found" };
  return { ok: true, closed: true, thread };
}

/** The drafts of a thread that could still have been sent before it closed. */
async function invalidateProspectDrafts(db: D1Database, leadId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE prospect_drafts SET status = 'invalidated'
       WHERE lead_id = ? AND status IN ('waiting', 'approved')`,
    )
    .bind(leadId)
    .run();
}

/**
 * The drafts of a thread that could still be sent, read before they are retired.
 *
 * An owner message invalidates every pending draft in the same transaction, so
 * the ids have to be collected first — they are what tells the account's outbox
 * to drop any retry queued behind them.
 */
export async function pendingProspectDraftIds(
  db: D1Database,
  leadId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT draft_id FROM prospect_drafts
       WHERE lead_id = ? AND status IN ('waiting', 'approved')
       ORDER BY draft_id`,
    )
    .bind(leadId)
    .all<{ draft_id: string }>();

  return results.map((r) => r.draft_id);
}

/**
 * One draft decision, as the page records it.
 *
 * `from` is the status the caller believes the draft is in: an approval that
 * races a decision already made changes nothing and says so, rather than
 * overwriting an answer somebody gave a moment earlier.
 */
export async function decideProspectDraft(
  db: D1Database,
  d: {
    draftId: string;
    from: readonly ProspectDraftStatus[];
    status: ProspectDraftStatus;
    decidedText: string | null;
    decidedAt: number | null;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE prospect_drafts SET status = ?, decided_text = ?, decided_at = ?
       WHERE draft_id = ? AND status IN (${d.from.map(() => "?").join(", ")})`,
    )
    .bind(d.status, d.decidedText, d.decidedAt, d.draftId, ...d.from)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** The lead's latest message, per thread — the one a reply has to answer. */
const LATEST_MESSAGE =
  `(SELECT x.mid FROM prospect_messages x
    WHERE x.lead_id = t.lead_id
    ORDER BY x.sent_at DESC, x.mid DESC LIMIT 1)`;

export interface ProspectWorkItem {
  thread: ProspectThreadDetail;
  /** The unanswered inbound that started the current wait. */
  inbound: ProspectMessage;
  /** The whole conversation, oldest first, so the draft can answer it. */
  messages: ProspectMessage[];
}

/**
 * Enrolled threads whose latest message is the lead's and that still need a
 * reply, oldest wait first.
 *
 * "Needs a reply" means no draft for the current conversation version. A draft
 * written before the last message is stale, and the thread comes back.
 * `invalidated` is the one status that does not count: that draft was retired
 * precisely because the conversation moved on.
 */
export async function prospectWork(
  db: D1Database,
  limit: number,
): Promise<ProspectWorkItem[]> {
  const { results } = await db
    .prepare(
      `SELECT t.lead_id, t.ig_user_id, t.igsid, t.handle, t.name, t.nicho, t.state, t.m1_sha,
              t.m1_registered_at, t.version, t.last_inbound_at, t.last_outbound_at,
              t.enrolled_at, t.touch_done_at, t.followup_sent_at, t.close_reason,
              t.profile_summary, t.profile_read_at, t.created_at, t.updated_at,
              m.mid AS inbound_mid, m.text AS inbound_text, m.sent_at AS inbound_sent_at,
              m.origin AS inbound_origin, m.drafted_at AS inbound_drafted_at,
              m.answered_at AS inbound_answered_at
       FROM prospect_threads t
       JOIN prospect_messages m ON m.mid = ${LATEST_MESSAGE}
       WHERE t.state = 'enrolled'
         AND m.direction = 'in'
         AND NOT EXISTS (
           SELECT 1 FROM prospect_drafts d
           WHERE d.lead_id = t.lead_id AND d.base_version = t.version
             AND d.status != 'invalidated'
         )
       ORDER BY m.sent_at ASC, t.lead_id ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<ProspectThreadDetailRow & {
      inbound_mid: string;
      inbound_text: string;
      inbound_sent_at: number;
      inbound_origin: string;
      inbound_drafted_at: number | null;
      inbound_answered_at: number | null;
    }>();

  const items = results.map((r) => ({
    thread: toProspectThreadDetail(r),
    inbound: toProspectMessage({
      mid: r.inbound_mid,
      lead_id: r.lead_id,
      direction: "in",
      origin: r.inbound_origin,
      text: r.inbound_text,
      sent_at: r.inbound_sent_at,
      drafted_at: r.inbound_drafted_at,
      answered_at: r.inbound_answered_at,
    }),
    messages: [] as ProspectMessage[],
  }));

  const byLead = new Map(items.map((i) => [i.thread.leadId, i]));
  for (const message of await prospectMessagesFor(db, [...byLead.keys()])) {
    byLead.get(message.leadId)?.messages.push(message);
  }

  return items;
}

/* ------------------------------------------------- prospect follow-ups (T19) */

const DAY_MS = 86_400_000;

/** From this long after the M1 echo, the no-DM touch is the step due. */
export const FOLLOWUP_TOUCH_AFTER_MS = 3 * DAY_MS;

/** From here the single hand-sent follow-up DM is due, beside an unmarked touch. */
export const FOLLOWUP_DM_AFTER_MS = 7 * DAY_MS;

/** A thread nobody has said anything in for this long is closed `no_reply`. */
export const FOLLOWUP_CLOSE_AFTER_MS = 14 * DAY_MS;

export type ProspectFollowupStep = "toque" | "dm";

export interface ProspectFollowupItem {
  thread: ProspectThreadDetail;
  /** Which of the two manual steps is due right now. */
  step: ProspectFollowupStep;
  /** Whole days since the M1 echo — what the card shows. */
  days: number;
}

/**
 * The "Seguimientos" queue: enrolled threads the lead never answered, with the
 * steps that are due now.
 *
 * "Never answered" is the absence of any inbound message, not a null column: a
 * thread the lead wrote back to leaves the queue the moment that message lands,
 * and the steps themselves are never shown again.
 *
 * One item per step that is due, so a thread can be in the queue twice: from day
 * 7 the DM is due whether or not the touch was done, because dropping an
 * unmarked touch at day 7 hid a step somebody still owed. Each step stops being
 * due when its own mark is set, and a thread past the closing line is left out
 * until the scheduled job closes it, so nothing invites a follow-up to a thread
 * that is about to be retired.
 */
export async function prospectFollowupQueue(
  db: D1Database,
  now = Date.now(),
): Promise<ProspectFollowupItem[]> {
  const touchCutoff = now - FOLLOWUP_TOUCH_AFTER_MS;
  const dmCutoff = now - FOLLOWUP_DM_AFTER_MS;
  const closeCutoff = now - FOLLOWUP_CLOSE_AFTER_MS;

  const { results } = await db
    .prepare(
      `SELECT ${PROSPECT_THREAD_COLUMNS} FROM prospect_threads
       WHERE state = 'enrolled' AND igsid IS NOT NULL
         AND enrolled_at IS NOT NULL AND enrolled_at > ?
         AND NOT EXISTS (
           SELECT 1 FROM prospect_messages m
           WHERE m.lead_id = prospect_threads.lead_id AND m.direction = 'in')
         AND (
           (enrolled_at <= ? AND touch_done_at IS NULL)
           OR (enrolled_at <= ? AND followup_sent_at IS NULL)
         )
       ORDER BY enrolled_at ASC, lead_id ASC`,
    )
    .bind(closeCutoff, touchCutoff, dmCutoff)
    .all<ProspectThreadDetailRow>();

  return results.flatMap((row) => {
    const thread = toProspectThreadDetail(row);
    const enrolledAt = thread.enrolledAt ?? now;
    const days = Math.floor(Math.max(0, now - enrolledAt) / DAY_MS);
    const steps: ProspectFollowupStep[] = [];
    if (enrolledAt <= touchCutoff && thread.touchDoneAt === null) steps.push("toque");
    if (enrolledAt <= dmCutoff && thread.followupSentAt === null) steps.push("dm");
    return steps.map((step) => ({ thread, step, days }));
  });
}

/**
 * "Hecho" on the touch step: a comment on a post or a reply to a story, never a
 * new DM.
 *
 * Marks the step once, for a thread that is still in the queue and old enough
 * for the step to be due — one the lead has answered, one that already has the
 * mark and one that is still inside its first three days are all refused rather
 * than overwritten. It stays markable after the DM step was sent: the touch is a
 * separate step, and dropping it there is how it used to go missing.
 */
export async function markProspectTouchDone(
  db: D1Database,
  leadId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE prospect_threads SET touch_done_at = ?, updated_at = ?
       WHERE lead_id = ? AND state = 'enrolled' AND igsid IS NOT NULL
         AND enrolled_at IS NOT NULL AND enrolled_at <= ?
         AND touch_done_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM prospect_messages m
           WHERE m.lead_id = prospect_threads.lead_id AND m.direction = 'in')`,
    )
    .bind(now, now, leadId, now - FOLLOWUP_TOUCH_AFTER_MS)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * "Enviado" on the DM step: the operator sent the follow-up from his phone.
 *
 * Nothing is stored from what he wrote — the page copies it and he pastes it —
 * and nothing is sent: this records that the one manual DM happened, which is
 * what keeps the queue from asking for it twice. The day-7 gate is part of the
 * write: a DM marked on day 2 would tell the queue the single follow-up is spent
 * when nothing had been sent yet.
 */
export async function markProspectFollowupSent(
  db: D1Database,
  leadId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE prospect_threads SET followup_sent_at = ?, updated_at = ?
       WHERE lead_id = ? AND state = 'enrolled' AND igsid IS NOT NULL
         AND enrolled_at IS NOT NULL AND enrolled_at <= ?
         AND followup_sent_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM prospect_messages m
           WHERE m.lead_id = prospect_threads.lead_id AND m.direction = 'in')`,
    )
    .bind(now, now, leadId, now - FOLLOWUP_DM_AFTER_MS)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** A thread the scheduled pass closed, with what the caller has to retire. */
export interface ProspectClosedFollowup {
  leadId: string;
  /** The account whose outbox may still hold a retry for this thread. */
  igUserId: string;
  /** Drafts that could still have been sent; their outbox retries are dropped. */
  draftIds: string[];
}

/**
 * Closes the threads that have been silent for fourteen days.
 *
 * Two ways to be silent, one reason: the thread the lead never answered since
 * its M1 echo, and the thread the lead answered and then left. The second is
 * counted from their last inbound message and only while nothing newer sits on
 * the thread — a reply of ours from yesterday is a live conversation, not a
 * silent one, so the wait is measured from whatever was said last.
 *
 * Closing is the same act as the page's close, minus the person: working drafts
 * are invalidated in the same batch, and the ids of what could still have been
 * sent come back so the caller can drop their queued retries. The `state =
 * 'enrolled'` condition is what makes it idempotent: a closed row no longer
 * matches, so a second run in the same hour writes nothing and leaves
 * `updated_at` alone. The reason is stored rather than derived, because "closed"
 * alone cannot tell a thread the Worker retired from one a person did.
 */
export async function closeUnansweredProspectThreads(
  db: D1Database,
  now = Date.now(),
): Promise<ProspectClosedFollowup[]> {
  const cutoff = now - FOLLOWUP_CLOSE_AFTER_MS;

  const { results } = await db
    .prepare(
      `SELECT lead_id, ig_user_id FROM prospect_threads
       WHERE state = 'enrolled'
         AND (
           (enrolled_at IS NOT NULL AND enrolled_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM prospect_messages m
              WHERE m.lead_id = prospect_threads.lead_id AND m.direction = 'in'))
           OR (last_inbound_at IS NOT NULL AND last_inbound_at <= ?
               AND (last_outbound_at IS NULL OR last_outbound_at <= ?))
         )
       ORDER BY lead_id ASC`,
    )
    .bind(cutoff, cutoff, cutoff)
    .all<{ lead_id: string; ig_user_id: string }>();

  const closed: ProspectClosedFollowup[] = [];
  for (const row of results) {
    const draftIds = await pendingProspectDraftIds(db, row.lead_id);
    const [threads] = await db.batch([
      db
        .prepare(
          `UPDATE prospect_threads SET state = 'closed', close_reason = 'no_reply',
                  updated_at = ?
           WHERE lead_id = ? AND state = 'enrolled'`,
        )
        .bind(now, row.lead_id),
      // Only for a thread that is closed, so a row that lost the race with an
      // inbound keeps its drafts: that conversation moved, it did not end.
      db
        .prepare(
          `UPDATE prospect_drafts SET status = 'invalidated'
           WHERE lead_id = ? AND status IN ('waiting', 'approved')
             AND EXISTS (SELECT 1 FROM prospect_threads t
                          WHERE t.lead_id = ? AND t.state = 'closed')`,
        )
        .bind(row.lead_id, row.lead_id),
    ]);

    if ((threads.meta.changes ?? 0) === 0) continue;
    closed.push({ leadId: row.lead_id, igUserId: row.ig_user_id, draftIds });
  }

  return closed;
}

/**
 * A reply the autopilot may send: authorized, still waiting, and in a thread the
 * API can answer right now.
 *
 * The filters are what the cron may even consider, not the decision to send —
 * the five checks still run inside the Worker for every attempt. Two of them are
 * mirrored here on purpose: a thread outside the 24 h window, or one whose last
 * word is ours, can never pass them, and without this the cron would re-attempt
 * the same impossible draft every fifteen minutes for as long as the row lives.
 * Neither filter trusts the other: `checkProspectSend` re-reads D1 either way.
 */
export interface ProspectAutopilotCandidate {
  draft: ProspectDraft;
  /** The account whose Durable Object owns this thread's claims and outbox. */
  igUserId: string;
  /** The thread's last outbound, for the five-minute spacing between sends. */
  lastOutboundAt: number | null;
  /**
   * When the current authorization was granted — the moment the human delay
   * runs from. A draft can be written hours before its stage graduates, and the
   * wait that makes a send look human is the one since autonomy was given.
   */
  authorizedAt: number;
}

export async function prospectAutopilotCandidates(
  db: D1Database,
  now: number,
  limit: number,
): Promise<ProspectAutopilotCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT d.*, t.ig_user_id, t.last_outbound_at,
              (SELECT a.created_at FROM prospect_authorizations a
                WHERE a.draft_id = d.draft_id AND a.gate_reason = '' AND a.expires_at > ?
                ORDER BY a.expires_at DESC, a.created_at DESC LIMIT 1) AS authorized_at
       FROM prospect_drafts d
       JOIN prospect_threads t ON t.lead_id = d.lead_id
       WHERE d.kind = 'reply' AND d.status = 'waiting' AND t.state = 'enrolled'
         AND t.last_inbound_at IS NOT NULL AND t.last_inbound_at > ?
         AND (SELECT x.direction FROM prospect_messages x
              WHERE x.lead_id = d.lead_id
              ORDER BY x.sent_at DESC, x.mid DESC LIMIT 1) = 'in'
         AND EXISTS (
           SELECT 1 FROM prospect_authorizations a
           WHERE a.draft_id = d.draft_id AND a.gate_reason = '' AND a.expires_at > ?)
       ORDER BY d.created_at ASC, d.draft_id ASC
       LIMIT ?`,
    )
    .bind(
      now,
      now - MESSAGE_WINDOW_MS,
      now,
      limit,
    )
    .all<
      ProspectDraftRow & {
        ig_user_id: string;
        last_outbound_at: number | null;
        authorized_at: number | null;
      }
    >();

  return results.map((r) => ({
    draft: toProspectDraft(r),
    igUserId: r.ig_user_id,
    lastOutboundAt: r.last_outbound_at,
    // The EXISTS above guarantees a row; the column is the same read, kept
    // nullable only because a correlated subquery is typed that way.
    authorizedAt: r.authorized_at ?? r.created_at,
  }));
}

/** D1 caps the bound parameters in one statement, so id lists go in chunks. */
function chunk<T>(items: readonly T[], size = 90): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Messages for a set of threads, oldest first. */
async function prospectMessagesFor(
  db: D1Database,
  leadIds: readonly string[],
): Promise<ProspectMessage[]> {
  const messages: ProspectMessage[] = [];

  for (const ids of chunk(leadIds)) {
    const { results } = await db
      .prepare(
        `SELECT mid, lead_id, direction, origin, text, sent_at, drafted_at, answered_at
         FROM prospect_messages
         WHERE lead_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY sent_at ASC, mid ASC`,
      )
      .bind(...ids)
      .all<ProspectMessageRow>();
    messages.push(...results.map(toProspectMessage));
  }

  return messages;
}

/**
 * Everything the Sheet and the session summary read, for threads touched since
 * `since` (epoch ms; 0 means all).
 *
 * Each returned thread comes with its full message history as metadata, because
 * an incremental poll still has to warn about a 20 h wait that started earlier.
 * Message text is not part of the export: the board shows activity, not what
 * anyone said.
 */
export async function prospectExport(
  db: D1Database,
  since: number,
): Promise<{
  threads: ProspectThreadDetail[];
  messages: ProspectMessage[];
  drafts: ProspectDraft[];
  authorizations: ProspectAuthorization[];
}> {
  const { results } = await db
    .prepare(
      `SELECT ${PROSPECT_THREAD_COLUMNS} FROM prospect_threads
       WHERE updated_at >= ? ORDER BY updated_at ASC, lead_id ASC`,
    )
    .bind(since)
    .all<ProspectThreadDetailRow>();

  const threads = results.map(toProspectThreadDetail);
  if (threads.length === 0) return { threads, messages: [], drafts: [], authorizations: [] };

  const messages = await prospectMessagesFor(db, threads.map((t) => t.leadId));
  const drafts: ProspectDraft[] = [];
  for (const ids of chunk(threads.map((t) => t.leadId))) {
    const { results: rows } = await db
      .prepare(
        `SELECT ${PROSPECT_DRAFT_COLUMNS}
         FROM prospect_drafts
         WHERE lead_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY created_at ASC, draft_id ASC`,
      )
      .bind(...ids)
      .all<ProspectDraftRow>();
    drafts.push(...rows.map(toProspectDraft));
  }

  const authorizations = await prospectAuthorizationsFor(
    db,
    drafts.map((d) => d.draftId),
  );

  return { threads, messages, drafts, authorizations };
}

/* --------------------------------------------------------------- campaigns */

interface CampaignRow {
  id: string;
  ig_user_id: string;
  name: string;
  media_id: string | null;
  keyword: string;
  keywords: string | null;
  match_mode: string;
  dedupe_scope: string;
  story_replies: number;
  ice_breaker: string | null;
  dm_message: string;
  public_reply: string | null;
  link_id: string | null;
  active: number;
  created_at: number;
}

/**
 * Splits what someone typed into the form's keyword field. Commas and newlines
 * both separate, because both are what people reach for in a one-line input.
 *
 * Case-insensitive duplicates are dropped: matching ignores case, so "Link" next
 * to "link" is one keyword listed twice and reads as a mistake in the dashboard.
 */
export function splitKeywords(input: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const keyword = raw.trim();
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    keywords.push(keyword);
  }
  return keywords;
}

/**
 * Reads the stored list, falling back to the single-keyword column behind it.
 *
 * That fallback is what a row written by pre-list code looks like: the column
 * defaults to an empty array, and a campaign matching nothing at all is a worse
 * answer than a campaign matching the one keyword it was created with.
 */
function toKeywords(r: CampaignRow): string[] {
  try {
    const parsed = JSON.parse(r.keywords ?? "[]");
    if (Array.isArray(parsed)) {
      const keywords = parsed.filter((k): k is string => typeof k === "string" && k.trim() !== "");
      if (keywords.length > 0) return keywords;
    }
  } catch {
    // Not JSON — same story as an empty list, handled below.
  }
  return splitKeywords(r.keyword ?? "");
}

const toCampaign = (r: CampaignRow): Campaign => ({
  id: r.id,
  igUserId: r.ig_user_id,
  name: r.name,
  mediaId: r.media_id,
  keywords: toKeywords(r),
  matchMode: r.match_mode === "whole_word" ? "whole_word" : "contains",
  dedupeScope: r.dedupe_scope === "campaign" ? "campaign" : "per_post",
  storyReplies: r.story_replies === 1,
  iceBreaker: r.ice_breaker,
  dmMessage: r.dm_message,
  publicReply: r.public_reply,
  linkId: r.link_id,
  active: r.active === 1,
  createdAt: r.created_at,
});

/** Active campaigns for an account, narrowest first — a post-specific campaign
 *  should win over an account-wide one for the same keyword. */
export async function activeCampaignsFor(
  db: D1Database,
  igUserId: string,
): Promise<Campaign[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM campaigns
       WHERE ig_user_id = ? AND active = 1
       ORDER BY (media_id IS NULL), created_at DESC`,
    )
    .bind(igUserId)
    .all<CampaignRow>();

  return results.map(toCampaign);
}

export async function listCampaigns(db: D1Database): Promise<Campaign[]> {
  const { results } = await db
    .prepare(`SELECT * FROM campaigns ORDER BY created_at DESC`)
    .all<CampaignRow>();
  return results.map(toCampaign);
}

export async function getCampaign(db: D1Database, id: string): Promise<Campaign | null> {
  const row = await db.prepare(`SELECT * FROM campaigns WHERE id = ?`).bind(id).first<CampaignRow>();
  return row ? toCampaign(row) : null;
}

export async function saveCampaign(
  db: D1Database,
  c: Omit<Campaign, "createdAt"> & { createdAt?: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO campaigns
         (id, ig_user_id, name, media_id, keyword, keywords, match_mode, dedupe_scope,
          story_replies, ice_breaker, dm_message, public_reply, link_id, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         ig_user_id = excluded.ig_user_id,
         name = excluded.name,
         media_id = excluded.media_id,
         keyword = excluded.keyword,
         keywords = excluded.keywords,
         match_mode = excluded.match_mode,
         dedupe_scope = excluded.dedupe_scope,
         story_replies = excluded.story_replies,
         ice_breaker = excluded.ice_breaker,
         dm_message = excluded.dm_message,
         public_reply = excluded.public_reply,
         link_id = excluded.link_id,
         active = excluded.active`,
    )
    .bind(
      c.id,
      c.igUserId,
      c.name,
      c.mediaId,
      // The pre-list column is NOT NULL and still written, so a rollback finds a
      // keyword rather than an empty string — see migration 0006.
      c.keywords[0] ?? "",
      JSON.stringify(c.keywords),
      c.matchMode,
      c.dedupeScope,
      c.storyReplies ? 1 : 0,
      c.iceBreaker,
      c.dmMessage,
      c.publicReply,
      c.linkId,
      c.active ? 1 : 0,
      c.createdAt ?? Date.now(),
    )
    .run();
}

export async function deleteCampaign(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM campaigns WHERE id = ?`).bind(id).run();
}

/* ------------------------------------------------------------------- links */

export async function saveLink(
  db: D1Database,
  link: { id: string; code: string; targetUrl: string; tracked?: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO links (id, code, target_url, clicks, tracked, created_at)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         target_url = excluded.target_url, tracked = excluded.tracked`,
    )
    .bind(link.id, link.code, link.targetUrl, link.tracked === false ? 0 : 1, Date.now())
    .run();
}

interface LinkRow {
  id: string;
  code: string;
  targetUrl: string;
  clicks: number;
  tracked: number;
  campaignName?: string | null;
  dmsSent?: number;
}

/**
 * D1 hands SQLite's 0/1 back as a number, and every caller of `tracked` compares
 * it against a boolean — `0 === false` is false, so an untracked link read as
 * tracked everywhere it mattered.
 */
const toLink = (r: LinkRow): Link => ({ ...r, tracked: r.tracked === 1 });

export async function getLink(db: D1Database, id: string): Promise<Link | null> {
  const row = await db
    .prepare(
      `SELECT id, code, target_url AS targetUrl, clicks, tracked FROM links WHERE id = ?`,
    )
    .bind(id)
    .first<LinkRow>();

  return row ? toLink(row) : null;
}

/** Resolves a short code, counting the click only when it's a real visitor. */
export async function resolveLink(
  db: D1Database,
  code: string,
  countIt: boolean,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT target_url FROM links WHERE code = ?`)
    .bind(code)
    .first<{ target_url: string }>();

  if (!row) return null;
  if (countIt) {
    await db.prepare(`UPDATE links SET clicks = clicks + 1 WHERE code = ?`).bind(code).run();
  }
  return row.target_url;
}

export async function listLinks(db: D1Database): Promise<Link[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.code, l.target_url AS targetUrl, l.clicks, l.tracked,
              c.name AS campaignName,
              (SELECT COUNT(*) FROM sends s
                WHERE s.campaign_id = c.id
                  AND s.status IN ('sent','recovered')) AS dmsSent
       FROM links l
       LEFT JOIN campaigns c ON c.link_id = l.id
       ORDER BY l.created_at DESC`,
    )
    .all<LinkRow>();
  return results.map(toLink);
}

/** Removes links no campaign points at — orphans from deleted or edited campaigns. */
export async function deleteOrphanLinks(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM links
       WHERE id NOT IN (SELECT link_id FROM campaigns WHERE link_id IS NOT NULL)`,
    )
    .run();
  return result.meta.changes ?? 0;
}

/* -------------------------------------------------------------- post stats */

export interface PostPerformance {
  mediaId: string;
  igUserId: string;
  sent: number;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  permalink: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
  fetchedAt: number | null;
}

/** How long anything read from the Graph API is trusted before re-reading it. */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Posts that actually produced DMs, newest first, with cached insights. */
export async function postPerformance(
  db: D1Database,
  limit = 5,
): Promise<PostPerformance[]> {
  const { results } = await db
    .prepare(
      `SELECT s.media_id AS mediaId, s.ig_user_id AS igUserId,
              SUM(CASE WHEN s.status IN ('sent','recovered') THEN 1 ELSE 0 END) AS sent,
              MAX(s.created_at) AS lastSend,
              p.reach, p.likes, p.comments, p.permalink, p.caption,
              p.thumbnail_url AS thumbnailUrl, p.media_type AS mediaType,
              p.fetched_at AS fetchedAt
       FROM sends s
       LEFT JOIN post_stats p ON p.media_id = s.media_id
       WHERE s.media_id IS NOT NULL
       GROUP BY s.media_id
       ORDER BY lastSend DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<PostPerformance & { lastSend: number }>();
  return results;
}

export function cacheIsStale(fetchedAt: number | null): boolean {
  return fetchedAt === null || Date.now() - fetchedAt > CACHE_TTL_MS;
}

export async function savePostStats(
  db: D1Database,
  mediaId: string,
  s: {
    reach: number | null;
    likes: number | null;
    comments: number | null;
    saved: number | null;
    shares: number | null;
    permalink: string | null;
    caption: string | null;
    thumbnailUrl: string | null;
    mediaType: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO post_stats
         (media_id, reach, likes, comments, saved, shares, permalink,
          caption, thumbnail_url, media_type, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (media_id) DO UPDATE SET
         reach = excluded.reach, likes = excluded.likes, comments = excluded.comments,
         saved = excluded.saved, shares = excluded.shares,
         permalink = excluded.permalink, caption = excluded.caption,
         thumbnail_url = excluded.thumbnail_url, media_type = excluded.media_type,
         fetched_at = excluded.fetched_at`,
    )
    .bind(
      mediaId, s.reach, s.likes, s.comments, s.saved, s.shares, s.permalink,
      s.caption, s.thumbnailUrl, s.mediaType, Date.now(),
    )
    .run();
}

/* ----------------------------------------------------------- account media */

export interface MediaItem {
  mediaId: string;
  igUserId: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  mediaType: string | null;
  /** Epoch ms the post was published, or null when Meta omitted it. */
  postedAt: number | null;
}

const mediaCheckKey = (igUserId: string) => `media_checked:${igUserId}`;

/**
 * When this account's media list was last read from Meta.
 *
 * Kept beside the rows rather than derived from them because an account with no
 * posts leaves no rows, and "no rows" would otherwise mean "ask Meta again" —
 * an API call every time the campaign form is opened, which is the one thing
 * this cache exists to prevent.
 */
export async function mediaCheckedAt(
  db: D1Database,
  igUserId: string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .bind(mediaCheckKey(igUserId))
    .first<{ value: string }>();

  const at = Number(row?.value);
  return Number.isFinite(at) ? at : null;
}

export async function listAccountMedia(
  db: D1Database,
  igUserId: string,
  limit = 24,
): Promise<MediaItem[]> {
  const { results } = await db
    .prepare(
      `SELECT media_id AS mediaId, ig_user_id AS igUserId, caption,
              thumbnail_url AS thumbnailUrl, permalink, media_type AS mediaType,
              posted_at AS postedAt
       FROM account_media
       WHERE ig_user_id = ?
       ORDER BY posted_at DESC
       LIMIT ?`,
    )
    .bind(igUserId, limit)
    .all<MediaItem>();
  return results;
}

/**
 * Replaces the cached list for one account.
 *
 * A clear-then-insert rather than an upsert, so a post deleted on Instagram — or
 * one that has scrolled out of the recent window — doesn't linger in a list
 * offering current posts. D1 runs a batch as one transaction, so the picker is
 * never read against the empty half of that.
 */
export async function saveAccountMedia(
  db: D1Database,
  igUserId: string,
  items: Array<Omit<MediaItem, "igUserId">>,
): Promise<void> {
  const now = Date.now();

  const statements = [
    db.prepare(`DELETE FROM account_media WHERE ig_user_id = ?`).bind(igUserId),
  ];

  for (const m of items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO account_media
             (media_id, ig_user_id, caption, thumbnail_url, permalink,
              media_type, posted_at, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (media_id) DO UPDATE SET
             ig_user_id = excluded.ig_user_id, caption = excluded.caption,
             thumbnail_url = excluded.thumbnail_url, permalink = excluded.permalink,
             media_type = excluded.media_type, posted_at = excluded.posted_at,
             fetched_at = excluded.fetched_at`,
        )
        .bind(
          m.mediaId, igUserId, m.caption, m.thumbnailUrl, m.permalink,
          m.mediaType, m.postedAt, now,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(mediaCheckKey(igUserId), String(now), now),
  );

  await db.batch(statements);
}

/* ------------------------------------------------------------------- sends */

export async function recordSend(
  db: D1Database,
  s: {
    campaignId: string;
    igUserId: string;
    commentId: string;
    commenterId: string;
    commenterUsername?: string;
    mediaId?: string;
    status: string;
    error?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sends
         (id, campaign_id, ig_user_id, comment_id, commenter_id,
          commenter_username, media_id, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      s.campaignId,
      s.igUserId,
      s.commentId,
      s.commenterId,
      s.commenterUsername ?? null,
      s.mediaId ?? null,
      s.status,
      s.error ?? null,
      Date.now(),
    )
    .run();
}

export async function recentSends(
  db: D1Database,
  opts: { status?: string; campaignId?: string; limit?: number } = {},
): Promise<Send[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.status === "sent") {
    // A recovered send is a sent one that arrived by the slower route; filtering
    // "sent" and getting a shorter list than the counter promised reads as a bug.
    where.push("status IN ('sent','recovered')");
  } else if (opts.status) {
    where.push("status = ?");
    binds.push(opts.status);
  }
  if (opts.campaignId) {
    where.push("campaign_id = ?");
    binds.push(opts.campaignId);
  }
  binds.push(opts.limit ?? 50);

  const { results } = await db
    .prepare(
      `SELECT id, campaign_id AS campaignId, commenter_username AS commenterUsername,
              status, error, created_at AS createdAt
       FROM sends
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<Send>();
  return results;
}

/**
 * Deletes a link only if no campaign uses it.
 *
 * Detaching instead would leave the campaign sending a DM that promises a link
 * and doesn't include one — a silent break in live copy. Delete the campaign, or
 * point it elsewhere, first.
 */
export async function deleteLink(
  db: D1Database,
  id: string,
): Promise<{ ok: true } | { ok: false; usedBy: string }> {
  const inUse = await db
    .prepare(`SELECT name FROM campaigns WHERE link_id = ? LIMIT 1`)
    .bind(id)
    .first<{ name: string }>();

  if (inUse) return { ok: false, usedBy: inUse.name };

  await db.prepare(`DELETE FROM links WHERE id = ?`).bind(id).run();
  return { ok: true };
}

/** Clears send history. Dedupe lives in the Durable Object, so this is safe —
 *  clearing the log does NOT let already-messaged people be messaged again. */
export async function clearSends(db: D1Database, campaignId?: string): Promise<number> {
  const result = campaignId
    ? await db.prepare(`DELETE FROM sends WHERE campaign_id = ?`).bind(campaignId).run()
    : await db.prepare(`DELETE FROM sends`).run();
  return result.meta.changes ?? 0;
}

/**
 * `sent` counts every delivered DM, recovered ones included — the headline
 * number should be how many people got the message, not how they got it.
 * `recovered` is broken out separately because it measures something else: how
 * often Meta's webhook didn't arrive.
 */
export async function sendStats(
  db: D1Database,
): Promise<{ sent: number; failed: number; duplicate: number; recovered: number }> {
  const { results } = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM sends GROUP BY status`)
    .all<{ status: string; n: number }>();

  const stats = { sent: 0, failed: 0, duplicate: 0, recovered: 0 };
  for (const r of results) {
    if (r.status in stats) stats[r.status as keyof typeof stats] = r.n;
  }
  stats.sent += stats.recovered;
  return stats;
}

/** Send counts per campaign, with the same `sent` semantics as sendStats. */
export async function campaignSendStats(
  db: D1Database,
): Promise<Map<string, { sent: number; failed: number; duplicate: number; recovered: number }>> {
  const { results } = await db
    .prepare(`SELECT campaign_id, status, COUNT(*) AS n FROM sends GROUP BY campaign_id, status`)
    .all<{ campaign_id: string; status: string; n: number }>();

  const byCampaign = new Map<string, { sent: number; failed: number; duplicate: number; recovered: number }>();
  for (const r of results) {
    const stats = byCampaign.get(r.campaign_id) ?? { sent: 0, failed: 0, duplicate: 0, recovered: 0 };
    if (r.status in stats) stats[r.status as keyof typeof stats] = r.n;
    byCampaign.set(r.campaign_id, stats);
  }
  for (const stats of byCampaign.values()) stats.sent += stats.recovered;
  return byCampaign;
}
