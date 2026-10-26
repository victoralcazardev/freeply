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
