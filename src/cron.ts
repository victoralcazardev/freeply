/**
 * Everything that runs without a request behind it.
 *
 * Two jobs, both of which fail silently if nobody does them: keeping access
 * tokens alive past their 60-day life, and finding the comments whose webhook
 * never arrived. Meta retries a failed delivery for a while and then stops, and
 * a private reply can't be sent more than 7 days after the comment — so a
 * dropped webhook is a lead that expires rather than one that waits.
 */

import * as db from "./db";
import {
  type CommentEvent,
  type Env,
  handleComment,
  matchesKeyword,
  refreshRecentMediaStats,
  refreshStaleAccountMedia,
} from "./index";
import { listRecentComments, listRecentMedia, refreshLongLivedToken } from "./instagram";

const DAY_MS = 86_400_000;

/** Cron that refreshes tokens. Anything else on the schedule reconciles. */
export const TOKEN_REFRESH_CRON = "7 4 * * *";

/** Refresh a token this close to expiry — seven daily attempts before it lapses. */
const REFRESH_WINDOW_MS = 7 * DAY_MS;

/** Meta refuses a token under 24 hours old; the extra hour absorbs cron drift. */
const MIN_TOKEN_AGE_MS = 25 * 60 * 60 * 1000;

/**
 * How far back a comment can be and still be worth recovering. Meta closes the
 * private-reply window at 7 days, and an hour of margin keeps us from spending
 * an attempt on a window that shuts mid-flight.
 */
const REPLY_WINDOW_MS = 7 * DAY_MS - 60 * 60 * 1000;

/**
 * Caps per run. A busy account has to not exhaust the invocation, and Instagram
 * allows roughly 200 API calls an hour per user — at four runs an hour this
 * spends at most ~28 of them, leaving the dashboard and the sends themselves
 * plenty of room.
 */
const MAX_MEDIA_PER_RUN = 6;
const MAX_COMMENTS_PER_MEDIA = 50;
const MAX_RECOVERIES_PER_RUN = 25;

/**
 * Accounts polled per run. Each one spends several Graph calls and D1 writes, so
 * an unbounded loop would exhaust the invocation's subrequest budget on an
 * instance with many accounts. Kept low enough to stay inside the free-tier
 * limit; the rotation cursor means the accounts left out this run lead the next.
 */
const MAX_ACCOUNTS_PER_RUN = 5;

/** Stop re-attempting a comment that has failed this many times. */
const MAX_RECOVERY_FAILURES = 3;

/**
 * Post stats go stale on this clock instead of the dashboard's 15-minute TTL —
 * nobody should have to open the dashboard just to keep the numbers fresh. At
 * one sweep an hour the worst case is 12 posts × 3 Graph calls, comfortably
 * inside the hourly budget reconcile's caps already account for.
 */
const STATS_MAX_AGE_MS = 60 * 60 * 1000;

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === TOKEN_REFRESH_CRON) await refreshTokens(env);
  else {
    await reconcile(env);
    // Discovery before stats: a post published since the last cycle gets its
    // row first, so the very same sweep can fill its numbers in.
    await refreshStaleAccountMedia(env, STATS_MAX_AGE_MS);
    await refreshRecentMediaStats(env, STATS_MAX_AGE_MS);
  }
}

/* --------------------------------------------------------------- refresh */

/**
 * Extends any token near the end of its life.
 *
 * Failure has to be loud rather than persistent: a refusal Meta won't reverse
 * means the account has to be re-authorized by a human, and asking Meta again
 * every day until then just buries the one log line that mattered.
 */
export async function refreshTokens(env: Env): Promise<void> {
  const now = Date.now();
  const due = await db.accountsDueForRefresh(env.DB, now + REFRESH_WINDOW_MS);
  if (due.length === 0) {
    console.log("token refresh: nothing expiring within 7 days");
    return;
  }

  for (const account of due) {
    const label = `@${account.username} (${account.igUserId})`;

    if (account.tokenExpiresAt !== null && account.tokenExpiresAt <= now) {
      await db.markNeedsReconnect(env.DB, account.igUserId, "token expired before it was refreshed");
      console.error(`token refresh: ${label} has already expired — reconnect required`);
      continue;
    }

    const age = now - (account.lastRefreshedAt ?? account.connectedAt);
    if (age < MIN_TOKEN_AGE_MS) {
      console.log(`token refresh: ${label} is under 24h old, Meta would refuse it`);
      continue;
    }

    const token = await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, account.igUserId);
    if (!token) {
      await db.markNeedsReconnect(env.DB, account.igUserId, "stored token could not be decrypted");
      console.error(`token refresh: ${label} token won't decrypt — reconnect required`);
      continue;
    }

    const result = await refreshLongLivedToken(token);
    if (result.ok && result.accessToken) {
      await db.updateAccountToken(
        env.DB,
        env.ENCRYPTION_KEY,
        account.igUserId,
        result.accessToken,
        result.expiresIn ?? 0,
      );
      const days = Math.round((result.expiresIn ?? 0) / 86_400);
      console.log(`token refresh: ${label} renewed, now expires in ${days} days`);
      continue;
    }

    if (result.permanent) {
      await db.markNeedsReconnect(env.DB, account.igUserId, result.error ?? "refresh refused");
      console.error(`token refresh: ${label} refused — ${result.error}`);
    } else {
      console.error(`token refresh: ${label} failed, retrying tomorrow — ${result.error}`);
    }
  }
}

/* ---------------------------------------------------------- reconciliation */

/**
 * Polls recent comments and replays anything the webhook never delivered.
 *
 * Recovered comments go through `handleComment` rather than a shortcut of their
 * own, so the dedupe DO still guarantees one message per commenter no matter
 * which route the comment took to get here. The `sends` check in front of it is
 * only there to keep the common case cheap.
 */
export async function reconcile(env: Env): Promise<void> {
  const host = await db.knownHost(env.DB);
  const accounts = await db.accountsToReconcile(env.DB);
  if (accounts.length === 0) return;

  // Take a bounded slice, rotating through the list from where the last run
  // stopped so no account is perpetually skipped by username ordering.
  const start = (await db.getReconcileCursor(env.DB)) % accounts.length;
  const take = Math.min(MAX_ACCOUNTS_PER_RUN, accounts.length);
  const slice = Array.from({ length: take }, (_, i) => accounts[(start + i) % accounts.length]);
  // Persist the advance now, before the work: the subrequest budget this guards
  // against is exactly what could stop the run from reaching an "after", and a
  // cursor that only moves on success would retry the same head forever.
  await db.setReconcileCursor(env.DB, (start + take) % accounts.length);

  const now = Date.now();
  const windowStart = now - REPLY_WINDOW_MS;

  for (const account of slice) {
    const token = await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, account.igUserId);
    if (!token) {
      console.error(`reconcile: no usable token for @${account.username}`);
      continue;
    }

    const campaigns = await db.activeCampaignsFor(env.DB, account.igUserId);
    const mediaIds = await mediaToPoll(campaigns, token);
    if (mediaIds.length === 0) continue;

    // One lookup per account instead of one per comment. The lookback runs a day
    // wider than the reply window because a send is dated when it went out, not
    // when the comment was written.
    const settled = await db.settledCommentIds(
      env.DB,
      account.igUserId,
      windowStart - DAY_MS,
      MAX_RECOVERY_FAILURES,
    );
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(account.igUserId));
    for (const id of await stub.pendingCommentIds()) settled.add(id);

    let examined = 0;
    let recovered = 0;
    const outcomes: Record<string, number> = {};

    for (const mediaId of mediaIds) {
      if (recovered >= MAX_RECOVERIES_PER_RUN) break;

      for (const comment of await listRecentComments(mediaId, token, MAX_COMMENTS_PER_MEDIA)) {
        if (recovered >= MAX_RECOVERIES_PER_RUN) break;
        // A comment older than the window can't be replied to at all, so there is
        // nothing to recover and no reason to spend a lookup on it.
        if (comment.timestamp !== null && comment.timestamp < windowStart) continue;
        if (settled.has(comment.id)) continue;
        // Our own public replies come back as comments on the same post. The ID
        // check in handleComment catches them, but only when Meta returned `from`.
        if (comment.username && comment.username === account.username) continue;
        // Most comments on a post mention no keyword at all and never will, so
        // they'd otherwise cost two D1 reads apiece on every run for the rest of
        // the week. Same predicate handleComment uses, minus the per-post
        // scoping — it can only be more permissive than the real decision.
        if (!campaigns.some((c) => matchesKeyword(comment.text, c.keywords, c.matchMode))) {
          continue;
        }

        examined++;
        const event: CommentEvent = {
          igUserId: account.igUserId,
          commentId: comment.id,
          mediaId,
          commenterId: comment.commenterId,
          commenterUsername: comment.username,
          text: comment.text,
        };
        const outcome = await handleComment(event, env, host ?? "", "reconcile");
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        if (outcome === "recovered" || outcome === "queued") recovered++;
      }
    }

    if (examined > 0) {
      const detail = Object.entries(outcomes)
        .map(([k, n]) => `${k}=${n}`)
        .join(" ");
      console.log(
        `reconcile: @${account.username} — ${examined} keyword comment(s) with no send ` +
          `record across ${mediaIds.length} post(s): ${detail}`,
      );
    }
  }
}

/**
 * Which posts to poll for this account.
 *
 * Campaigns pinned to a post name their own; an account-wide campaign has to be
 * asked what "the account" currently means. Pinned posts come first, because a
 * campaign someone deliberately aimed at a post matters more than the newest
 * upload when the cap bites.
 */
async function mediaToPoll(campaigns: db.Campaign[], token: string): Promise<string[]> {
  const pinned = campaigns
    .map((c) => c.mediaId)
    .filter((id): id is string => id !== null);

  const accountWide = campaigns.some((c) => c.mediaId === null);
  const recent = accountWide ? await listRecentMedia(token, MAX_MEDIA_PER_RUN) : [];

  return [...new Set([...pinned, ...recent])].slice(0, MAX_MEDIA_PER_RUN);
}
