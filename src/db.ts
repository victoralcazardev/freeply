import { decrypt, encrypt } from "./crypto";

export interface Account {
  igUserId: string;
  username: string;
  tokenExpiresAt: number | null;
  connectedAt: number;
  /** The refresh cron gave up; only re-authorizing by hand will fix it. */
  needsReconnect: boolean;
  reconnectReason: string | null;
  /** Set by the dashboard's Disconnect button; cleared on reconnect. */
  disconnectedAt: number | null;
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
         reconnect_reason = NULL,
         disconnected_at = NULL`,
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
         AND disconnected_at IS NULL
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
         AND a.disconnected_at IS NULL
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
              needs_reconnect, reconnect_reason, disconnected_at
       FROM accounts ORDER BY username`,
    )
    .all<{
      ig_user_id: string;
      username: string;
      token_expires_at: number | null;
      connected_at: number;
      needs_reconnect: number;
      reconnect_reason: string | null;
      disconnected_at: number | null;
    }>();

  return results.map((r) => ({
    igUserId: r.ig_user_id,
    username: r.username,
    tokenExpiresAt: r.token_expires_at,
    connectedAt: r.connected_at,
    needsReconnect: r.needs_reconnect === 1,
    reconnectReason: r.reconnect_reason,
    disconnectedAt: r.disconnected_at,
  }));
}

/**
 * Disconnects an account without deleting its row — deleting it cascaded
 * through campaigns.ig_user_id ON DELETE CASCADE and took every campaign with
 * it (see migration 0014). Flips a flag and deactivates its campaigns
 * instead, so reconnecting the same ig_user_id finds the row, and its
 * campaigns, right where they were.
 */
export async function disconnectAccount(db: D1Database, igUserId: string): Promise<void> {
  // Batched, so the flag and the deactivation land in one transaction. As two
  // statements the second could fail on its own and leave an account marked
  // disconnected while its campaigns kept matching comments — a disconnect that
  // reads as done in the dashboard and is still live at the webhook.
  await db.batch([
    db
      .prepare(`UPDATE accounts SET disconnected_at = ? WHERE ig_user_id = ?`)
      .bind(Date.now(), igUserId),
    db
      .prepare(`UPDATE campaigns SET active = 0 WHERE ig_user_id = ? AND active = 1`)
      .bind(igUserId),
  ]);
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
    views: number | null;
    skipRate: number | null;
    avgWatchMs: number | null;
    // Optional: D1 rejects `undefined` outright, and a caller built before these
    // columns existed simply omits them. Coerced to null at bind time below.
    totalWatchMs?: number | null;
    interactions?: number | null;
    reposts?: number | null;
    follows?: number | null;
    profileVisits?: number | null;
    permalink: string | null;
    caption: string | null;
    thumbnailUrl: string | null;
    mediaType: string | null;
  },
): Promise<void> {
  // One clock reading for both writes, so the snapshot's observed_at and the
  // cache's fetched_at can never disagree about when this sweep happened.
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO post_stats
         (media_id, reach, likes, comments, saved, shares, views, skip_rate,
          avg_watch_ms, total_watch_ms, interactions, reposts,
          follows, profile_visits,
          permalink, caption, thumbnail_url, media_type, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (media_id) DO UPDATE SET
         reach = excluded.reach, likes = excluded.likes, comments = excluded.comments,
         saved = excluded.saved, shares = excluded.shares,
         views = excluded.views, skip_rate = excluded.skip_rate,
         avg_watch_ms = excluded.avg_watch_ms,
         total_watch_ms = excluded.total_watch_ms,
         interactions = excluded.interactions, reposts = excluded.reposts,
         follows = excluded.follows, profile_visits = excluded.profile_visits,
         permalink = excluded.permalink, caption = excluded.caption,
         thumbnail_url = excluded.thumbnail_url, media_type = excluded.media_type,
         fetched_at = excluded.fetched_at`,
    )
    .bind(
      mediaId, s.reach, s.likes, s.comments, s.saved, s.shares, s.views,
      s.skipRate, s.avgWatchMs,
      s.totalWatchMs ?? null, s.interactions ?? null, s.reposts ?? null,
      s.follows ?? null, s.profileVisits ?? null,
      s.permalink, s.caption, s.thumbnailUrl, s.mediaType, now,
    )
    .run();

  await appendStatsSnapshot(db, mediaId, now, s);
}

/**
 * Append one row to the time series, but only when something actually moved.
 *
 * The upsert above is destructive by design — `post_stats` answers "where is this
 * post now" and only ever needs one row. This keeps the readings it overwrites,
 * which is what makes it possible to compare two posts at the same AGE instead of
 * comparing a fresh post against a settled one.
 *
 * The `NOT EXISTS` guard compares against the post's most recent snapshot and
 * skips the insert when every metric matches. That is what stops a two-year-old
 * post accruing an identical row every hour forever: rows accumulate while a post
 * is moving and stop by themselves once it settles, so there is no retention job
 * to write and no pruning cron to forget about. `IS` rather than `=` throughout,
 * because these columns are routinely NULL (Meta's "in development" reel metrics
 * drop out at random) and `NULL = NULL` is NULL, which would defeat the guard and
 * insert a duplicate row every single sweep.
 */
export async function appendStatsSnapshot(
  db: D1Database,
  mediaId: string,
  observedAt: number,
  s: {
    views: number | null;
    reach: number | null;
    skipRate: number | null;
    avgWatchMs: number | null;
    totalWatchMs?: number | null;
    interactions?: number | null;
    likes: number | null;
    comments: number | null;
    saved: number | null;
    shares: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO post_stats_history
         (media_id, observed_at, age_ms, views, reach, skip_rate, avg_watch_ms,
          total_watch_ms, interactions, likes, comments, saved, shares)
       SELECT ?1, ?2,
              (SELECT ?2 - m.posted_at FROM account_media m WHERE m.media_id = ?1),
              ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
       WHERE NOT EXISTS (
         SELECT 1 FROM post_stats_history h
         WHERE h.media_id = ?1
           AND h.observed_at = (
             SELECT MAX(observed_at) FROM post_stats_history WHERE media_id = ?1)
           AND h.views IS ?3 AND h.reach IS ?4 AND h.skip_rate IS ?5
           AND h.avg_watch_ms IS ?6 AND h.total_watch_ms IS ?7
           AND h.interactions IS ?8 AND h.likes IS ?9 AND h.comments IS ?10
           AND h.saved IS ?11 AND h.shares IS ?12
       )
       ON CONFLICT (media_id, observed_at) DO UPDATE SET
         views = excluded.views, reach = excluded.reach,
         skip_rate = excluded.skip_rate, avg_watch_ms = excluded.avg_watch_ms,
         total_watch_ms = excluded.total_watch_ms, interactions = excluded.interactions,
         likes = excluded.likes, comments = excluded.comments,
         saved = excluded.saved, shares = excluded.shares`,
    )
    .bind(
      mediaId, observedAt,
      s.views, s.reach, s.skipRate, s.avgWatchMs,
      s.totalWatchMs ?? null, s.interactions ?? null,
      s.likes, s.comments, s.saved, s.shares,
    )
    .run();
}

/**
 * Recent posts whose cached stats are missing or aged out, newest first.
 *
 * post_stats otherwise only fills for posts that produced sends (the overview's
 * join starts from `sends`), so a post with no campaign never gets stats at
 * all — which makes the cache describe the funnels, not the account.
 */
export async function staleRecentMediaStats(
  db: D1Database,
  limit: number,
  maxAgeMs = CACHE_TTL_MS,
): Promise<Array<{ mediaId: string; igUserId: string }>> {
  // Zero means the caller is overriding the cache, not describing a short one.
  // Compared as `fetched_at < now` it excludes a row stamped this millisecond,
  // which is the one row a manual refresh most wants — see the matching note in
  // refreshStaleAccountMedia.
  const ignoreCache = maxAgeMs <= 0;
  const cutoff = Date.now() - maxAgeMs;
  // A disconnected account keeps its rows (migration 0014 never deletes them),
  // so without this filter its old posts stay permanently stale and the sweep
  // spends its whole per-run budget calling Meta with a token the operator has
  // already revoked. LEFT JOIN rather than an inner one: media whose account row
  // is genuinely gone still belongs in the list, and `disconnected_at IS NULL`
  // is true for that case too.
  const { results } = await db
    .prepare(
      `SELECT m.media_id AS mediaId, m.ig_user_id AS igUserId
       FROM account_media m
       LEFT JOIN post_stats p ON p.media_id = m.media_id
       LEFT JOIN accounts a ON a.ig_user_id = m.ig_user_id
       WHERE a.disconnected_at IS NULL
         AND (?1 OR p.fetched_at IS NULL OR p.fetched_at < ?2)
       ORDER BY m.posted_at DESC
       LIMIT ?3`,
    )
    .bind(ignoreCache ? 1 : 0, cutoff, limit)
    .all<{ mediaId: string; igUserId: string }>();
  return results;
}

/**
 * The shortcode out of a permalink — `.../reel/ABC123/` and `.../p/ABC123/` both
 * yield `ABC123`. It is the key the editorial layer uses (see post_notes), because
 * it survives a post being deleted and a human can read it off a URL.
 */
export function shortcodeFromPermalink(permalink: string | null): string {
  const m = /\/(?:reel|p|tv)\/([^/?#]+)/.exec(permalink ?? "");
  return m ? m[1] : "";
}

/**
 * The full stats table the MCP endpoint and /stats.json serve.
 *
 * Every column the sweep collects, plus the editorial note for that post.
 *
 * Five columns were being written and never read until 2026-08-12 —
 * total_watch_ms, interactions, reposts, follows and profile_visits were absent
 * from this SELECT, so nothing downstream had ever seen them despite the sweep
 * having stored them since early August. total_watch_ms in particular is the one
 * metric here that is neither a rate nor an average, which makes it the only
 * honest way to compare a short post against a long one.
 */
export async function postStatsReport(db: D1Database, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT m.permalink, m.caption, m.posted_at AS postedAt, m.media_type AS mediaType,
              p.views, p.reach, p.skip_rate AS skipRate, p.avg_watch_ms AS avgWatchMs,
              p.total_watch_ms AS totalWatchMs, p.interactions, p.reposts,
              p.follows, p.profile_visits AS profileVisits,
              p.likes, p.comments, p.saved, p.shares
       FROM account_media m
       LEFT JOIN post_stats p ON p.media_id = m.media_id
       ORDER BY m.posted_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<Record<string, unknown>>();

  // The note is attached in TS rather than SQL because post_notes is keyed by
  // shortcode and account_media by media_id; deriving the shortcode here is the
  // same work as doing it in SQLite string functions, and legible.
  const notes = await postNotes(db);
  return results.map((r) => ({
    ...r,
    note: notes[shortcodeFromPermalink(r.permalink as string | null)] ?? null,
  }));
}

/* ------------------------------------------------------- editorial notes */

export interface PostNote {
  fmt: string | null;
  status: string | null;
  pill: string | null;
  why: string | null;
  updatedAt: number;
}

/** Every judgement, keyed by shortcode. Small table — one row per post ever. */
export async function postNotes(db: D1Database): Promise<Record<string, PostNote>> {
  const { results } = await db
    .prepare(
      `SELECT shortcode, fmt, status, pill, why, updated_at AS updatedAt FROM post_notes`,
    )
    .all<{ shortcode: string } & PostNote>();
  const out: Record<string, PostNote> = {};
  for (const { shortcode, ...note } of results) out[shortcode] = note;
  return out;
}

/**
 * Write one judgement. Upsert, because re-judging a post is the normal case —
 * a verdict written at 24h should be replaced at day 7, not appended to.
 */
export async function savePostNote(
  db: D1Database,
  shortcode: string,
  n: { fmt?: string | null; status?: string | null; pill?: string | null; why?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO post_notes (shortcode, fmt, status, pill, why, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (shortcode) DO UPDATE SET
         fmt = excluded.fmt, status = excluded.status,
         pill = excluded.pill, why = excluded.why,
         updated_at = excluded.updated_at`,
    )
    .bind(shortcode, n.fmt ?? null, n.status ?? null, n.pill ?? null, n.why ?? null, Date.now())
    .run();
}

/* --------------------------------------------------------- time series */

/**
 * Every post's reading nearest a given age, so posts can be compared at the same
 * point in their life instead of "whatever each one happens to be at now".
 *
 * `toleranceMs` bounds how far from the requested age a snapshot may sit and
 * still count — without it, a post whose nearest reading is four days off the
 * 24-hour mark would silently answer a question about its first day. Posts with
 * no snapshot inside the tolerance are omitted rather than approximated: this
 * table starts empty on 2026-08-12, so for a while most posts have no early
 * history at all and a guess would be indistinguishable from a measurement.
 */
export async function statsAtAge(
  db: D1Database,
  ageMs: number,
  toleranceMs: number,
  limit = 48,
) {
  const { results } = await db
    .prepare(
      `SELECT m.permalink, m.posted_at AS postedAt, h.observed_at AS observedAt,
              h.age_ms AS ageMs, h.views, h.reach, h.skip_rate AS skipRate,
              h.avg_watch_ms AS avgWatchMs, h.total_watch_ms AS totalWatchMs,
              h.interactions, h.likes, h.comments, h.saved, h.shares
       FROM account_media m
       JOIN post_stats_history h ON h.media_id = m.media_id
       WHERE h.age_ms IS NOT NULL
         AND ABS(h.age_ms - ?1) <= ?2
         AND ABS(h.age_ms - ?1) = (
           SELECT MIN(ABS(h2.age_ms - ?1)) FROM post_stats_history h2
           WHERE h2.media_id = m.media_id AND h2.age_ms IS NOT NULL)
       GROUP BY m.media_id
       ORDER BY m.posted_at DESC
       LIMIT ?3`,
    )
    .bind(ageMs, toleranceMs, limit)
    .all();
  return results;
}

/**
 * Escapes the LIKE wildcards in a value that is meant to match literally.
 *
 * Instagram shortcodes are drawn from `[A-Za-z0-9_-]`, so roughly one in five
 * carries an underscore — which LIKE reads as "any single character". Unescaped,
 * `Dbi3lYEJ_-s` also matches `Dbi3lYEJx-s`, and the trajectory returned would be
 * two posts' readings interleaved with nothing to say so.
 */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** The whole curve for one post, oldest reading first. */
export async function postTrajectory(db: D1Database, shortcode: string) {
  const { results } = await db
    .prepare(
      `SELECT h.observed_at AS observedAt, h.age_ms AS ageMs, h.views, h.reach,
              h.skip_rate AS skipRate, h.avg_watch_ms AS avgWatchMs,
              h.total_watch_ms AS totalWatchMs, h.interactions,
              h.likes, h.comments, h.saved, h.shares
       FROM post_stats_history h
       JOIN account_media m ON m.media_id = h.media_id
       WHERE m.permalink LIKE '%/' || ?1 || '/%' ESCAPE '\\'
       ORDER BY h.observed_at ASC`,
    )
    .bind(likeLiteral(shortcode))
    .all();
  return results;
}

/* -------------------------------------------------------- workspace state */

/** Sections the workspace page keeps. Anything else is rejected at the route, so
 *  a stray client can't grow this table a row at a time. */
export const WORKSPACE_SECTIONS = ["queue", "actions", "backlog", "miles", "ideas", "chats"];

/** Every stored section, shaped for the page's reconcile loop:
 *  `{ queue: { value, updatedAt }, … }`. Missing sections are simply absent —
 *  the page reads that as "server has never seen this" and seeds it. */
export async function workspaceState(db: D1Database) {
  const { results } = await db
    .prepare(`SELECT section, value, updated_at AS updatedAt FROM workspace_state`)
    .all<{ section: string; value: string; updatedAt: number }>();
  const out: Record<string, { value: unknown; updatedAt: number }> = {};
  for (const row of results) {
    try {
      out[row.section] = { value: JSON.parse(row.value), updatedAt: row.updatedAt };
    } catch {
      // A row that won't parse is worse than a missing one: the page would adopt
      // it and wipe a good local copy. Skip it and let this device re-seed.
    }
  }
  return out;
}

/** Upsert one section. Returns the stamp the page records as "what I last saw",
 *  which is what makes the next pull a no-op instead of a round trip. */
export async function saveWorkspaceState(db: D1Database, section: string, value: string) {
  const updatedAt = Date.now();
  await db
    .prepare(
      `INSERT INTO workspace_state (section, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(section) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(section, value, updatedAt)
    .run();
  return updatedAt;
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

/* ---------------------------------------------------------------- dm inbox */

export interface DMIdea {
  mid: string;
  igUserId: string;
  senderId: string;
  recipientId: string | null;
  isEcho: boolean;
  text: string | null;
  attachmentType: string | null;
  sharedUrl: string | null;
  sharedMediaId: string | null;
  receivedAt: number;
  processedAt: number | null;
}

/**
 * The operator's own account ids. Not derived from `accounts`: the account they
 * send ideas FROM has no token here, so it has no row there — filtering on the
 * accounts table would drop exactly the messages this feature exists to keep.
 */
export async function selfAccountIds(db: D1Database): Promise<string[]> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE key = 'dm_self_ids'`)
    .first<{ value: string }>();

  return (row?.value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Stores one self-sent DM. `INSERT OR IGNORE` on the message id because Meta
 * retries any delivery it doesn't get a prompt 200 for, and the same idea
 * arriving twice must not become two rows.
 */
export async function recordDMIdea(
  db: D1Database,
  idea: Omit<DMIdea, "processedAt"> & { rawJson: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO dm_inbox
         (mid, ig_user_id, sender_id, recipient_id, is_echo, text,
          attachment_type, shared_url, shared_media_id, raw_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      idea.mid,
      idea.igUserId,
      idea.senderId,
      idea.recipientId,
      idea.isEcho ? 1 : 0,
      idea.text,
      idea.attachmentType,
      idea.sharedUrl,
      idea.sharedMediaId,
      idea.rawJson,
      idea.receivedAt,
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function listDMIdeas(
  db: D1Database,
  opts: { limit?: number; openOnly?: boolean } = {},
): Promise<DMIdea[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const { results } = await db
    .prepare(
      `SELECT mid, ig_user_id, sender_id, recipient_id, is_echo, text,
              attachment_type, shared_url, shared_media_id, received_at, processed_at
         FROM dm_inbox
        ${opts.openOnly ? "WHERE processed_at IS NULL" : ""}
        ORDER BY received_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{
      mid: string;
      ig_user_id: string;
      sender_id: string;
      recipient_id: string | null;
      is_echo: number;
      text: string | null;
      attachment_type: string | null;
      shared_url: string | null;
      shared_media_id: string | null;
      received_at: number;
      processed_at: number | null;
    }>();

  return results.map((r) => ({
    mid: r.mid,
    igUserId: r.ig_user_id,
    senderId: r.sender_id,
    recipientId: r.recipient_id,
    isEcho: r.is_echo === 1,
    text: r.text,
    attachmentType: r.attachment_type,
    sharedUrl: r.shared_url,
    sharedMediaId: r.shared_media_id,
    receivedAt: r.received_at,
    processedAt: r.processed_at,
  }));
}

/** Marks an idea as folded into the queue so the next read skips it. */
export async function markDMIdeaProcessed(
  db: D1Database,
  mid: string,
  at: number,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE dm_inbox SET processed_at = ? WHERE mid = ? AND processed_at IS NULL`)
    .bind(at, mid)
    .run();

  return (result.meta.changes ?? 0) > 0;
}
