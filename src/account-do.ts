import { DurableObject } from "cloudflare:workers";
import * as db from "./db";
import { replyToComment, sendMessage, sendPrivateReply } from "./instagram";

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRUNE_DUE_KEY = "pruneDueAt";

/**
 * Delay before each retry. The last gap crosses an hour on purpose: Meta's app-
 * and user-level rate limits reset on a rolling hour, so giving up sooner would
 * discard exactly the messages a throttle was holding back. The whole schedule
 * spans under two hours, which is nothing against the 7-day private-reply window.
 */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Sends attempted per alarm, so one wave of retries can't run past the limit. */
const DRAIN_LIMIT = 20;

export interface SendJob {
  igUserId: string;
  campaignId: string;
  /**
   * Which send this is. `private_reply` answers a comment and is one-shot;
   * `dm` answers someone already in an open 24-hour window, which a story reply
   * opens by arriving. They fail differently and are worth telling apart in the
   * log, but they share every retry rule.
   */
  kind: "private_reply" | "dm";
  /** Who to send to, for a `dm`. Ignored for a private reply, which addresses
   *  the comment instead. */
  recipientId?: string;
  /**
   * What the commenter was claimed under, which is not always the campaign id —
   * an account-wide campaign claims per post. Kept separate because releasing
   * under the wrong key frees a claim nobody holds and leaves the real one
   * blocking that commenter for the rest of the prune window.
   */
  dedupeKey: string;
  /** The comment being answered, or for a `dm` the id of the message that
   *  triggered it — unique either way, which is all the outbox and log need. */
  commentId: string;
  commenterId: string;
  commenterUsername?: string;
  mediaId?: string;
  /** Fully substituted; the DO never sees a template. */
  message: string;
  publicReply?: string;
  /** 'sent' for a webhook, 'recovered' when reconciliation found the comment. */
  successStatus: string;
}

/** What the DO needs from the Worker's bindings to finish a send on its own. */
interface SendEnv {
  DB: D1Database;
  ENCRYPTION_KEY: string;
}

type OutboxRow = { job: string; attempts: number };

/**
 * One instance per connected Instagram account, keyed by IG user ID.
 *
 * Exists because Meta redelivers webhook events — we saw the same comment arrive
 * twice, three seconds apart. Instagram allows exactly one private reply per
 * commenter, so a duplicate isn't a harmless extra message; it's a wasted shot
 * that can't be retried. D1 is eventually consistent and would let a burst slip
 * through. A Durable Object is single-threaded per account, which is the
 * serialization this needs.
 *
 * It also owns the send itself, and the retry queue behind it. PLAN.md §3 puts
 * that on Cloudflare Queues, which would work — Queues has been on the free plan
 * since February 2026, so cost isn't the objection. The objection is that a
 * claim, its release, and the retry between them are one state machine. Split
 * across a queue and a DO they become two systems that can disagree: a message
 * in flight whose claim was already released, or a claim held for a message the
 * queue dropped. Here the alarm and the claim are the same SQLite transaction's
 * neighbours. It also keeps a fork at one Worker with no extra binding to
 * provision, which is the shape this project is trying to hold.
 */
export class AccountDO extends DurableObject<SendEnv> {
  constructor(ctx: DurableObjectState, env: SendEnv) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS seen (
          campaign_key TEXT NOT NULL,
          commenter_id TEXT NOT NULL,
          sent_at      INTEGER NOT NULL,
          PRIMARY KEY (campaign_key, commenter_id)
        )
      `);
      // Only holds sends Meta refused for a reason that might clear. A send that
      // succeeds first time never touches this table.
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS outbox (
          campaign_id  TEXT NOT NULL,
          comment_id   TEXT NOT NULL,
          job          TEXT NOT NULL,
          attempts     INTEGER NOT NULL,
          due_at       INTEGER NOT NULL,
          PRIMARY KEY (campaign_id, comment_id)
        )
      `);

      if ((await ctx.storage.get<number>(PRUNE_DUE_KEY)) === undefined) {
        await ctx.storage.put(PRUNE_DUE_KEY, Date.now() + PRUNE_INTERVAL_MS);
      }
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
      }
    });
  }

  /**
   * Records the intent to message this commenter. Returns false if they were
   * already claimed, meaning this delivery is a duplicate and must be dropped.
   */
  claim(campaignKey: string, commenterId: string): boolean {
    const cursor = this.ctx.storage.sql.exec(
      `INSERT INTO seen (campaign_key, commenter_id, sent_at)
       VALUES (?, ?, ?)
       ON CONFLICT (campaign_key, commenter_id) DO NOTHING`,
      campaignKey,
      commenterId,
      Date.now(),
    );
    return cursor.rowsWritten > 0;
  }

  /**
   * Undoes a claim when the send failed, so a later delivery can retry. Without
   * this a transient Meta error would permanently block that commenter.
   */
  release(campaignKey: string, commenterId: string): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM seen WHERE campaign_key = ? AND commenter_id = ?`,
      campaignKey,
      commenterId,
    );
  }

  /**
   * Sends the private reply, and the public one behind it.
   *
   * The first attempt runs inline so the caller — and `wrangler tail` — learns
   * the outcome at the moment the comment arrived. Only a failure worth
   * repeating goes into the outbox; queueing first and sending after would
   * survive a crash mid-send, at the cost of possibly re-sending a message that
   * did land. Against a one-shot private reply, losing one beats duplicating one.
   *
   * Returns the status written to `sends`, or "queued" while retries are pending.
   */
  async deliver(job: SendJob): Promise<string> {
    return this.attempt(job, 0);
  }

  /**
   * Forgets every claim for this account, so previously-messaged commenters can
   * be messaged again. Testing aid — in normal operation this is exactly the
   * state you want preserved.
   */
  clear(): number {
    const before = this.count();
    this.ctx.storage.sql.exec(`DELETE FROM seen`);
    return before;
  }

  /** Test/debug helper: how many commenters are currently claimed. */
  count(): number {
    const [row] = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM seen`)
      .toArray();
    return row?.n ?? 0;
  }

  /**
   * Comments whose send is mid-retry.
   *
   * Reconciliation has to leave these alone. They have no row in `sends` yet —
   * the outcome isn't known — so the poll would otherwise treat them as missed,
   * be turned away by the claim, and log a duplicate against a message that is
   * still on its way.
   */
  pendingCommentIds(): string[] {
    return this.ctx.storage.sql
      .exec<{ comment_id: string }>(`SELECT comment_id FROM outbox`)
      .toArray()
      .map((r) => r.comment_id);
  }

  async alarm(): Promise<void> {
    await this.drain();
    await this.prune();
    await this.scheduleNext();
  }

  private async attempt(job: SendJob, attempts: number): Promise<string> {
    // Re-read the token every attempt: a retry can outlive a refresh, and the
    // point of the refresh cron is that the token in D1 is the good one.
    const token = await db.getAccountToken(this.env.DB, this.env.ENCRYPTION_KEY, job.igUserId);
    if (!token) {
      this.release(job.dedupeKey, job.commenterId);
      return this.settle(job, "failed", "no usable access token — reconnect the account");
    }

    const result =
      job.kind === "dm"
        ? await sendMessage(job.igUserId, job.recipientId ?? job.commenterId, job.message, token)
        : await sendPrivateReply(job.igUserId, job.commentId, job.message, token);

    if (result.ok) {
      const what = job.kind === "dm" ? "DM" : "private reply";
      console.log(`sent ${what} to @${job.commenterUsername ?? job.commenterId}`);
      // Delivered, and a private reply is one-shot: drop the outbox row now,
      // before the public reply or the log write, so nothing can re-drain this
      // job and spend a second message on the same commenter.
      this.forget(job);
      // Only after a confirmed send — publicly pointing at a DM that never
      // arrived is worse than saying nothing.
      if (job.publicReply) {
        const posted = await replyToComment(job.commentId, job.publicReply, token);
        if (posted.ok) console.log("posted public reply");
        else console.error(`public reply failed (${posted.status}):`, posted.error);
      }
      // Recording the send is bookkeeping after the message is already out. A D1
      // failure here has to be loud but must not re-enter the retry path: the
      // outbox row is gone, so drain won't touch it, and re-sending a one-shot
      // reply is worse than a missing log line.
      try {
        await this.record(job, job.successStatus);
      } catch (cause) {
        console.error(`delivered but could not record send for ${job.commentId}:`, cause);
      }
      return job.successStatus;
    }

    if (result.retryable && attempts + 1 < MAX_ATTEMPTS) {
      return this.defer(job, attempts, `send failed (${result.status}): ${result.error}`);
    }

    if (result.authFailure) {
      // The token, not this message. Flag the account so the dashboard asks for
      // a reconnect, and let go of the claim so the lead can be recovered once
      // it happens — the comment is still inside its 7-day window.
      await db.markNeedsReconnect(this.env.DB, job.igUserId, result.error ?? "token rejected");
      this.release(job.dedupeKey, job.commenterId);
    } else if (result.retryable) {
      // Out of attempts on something that still looks temporary. Release, so a
      // redelivery or the reconciliation poll gets one more cycle at it.
      this.release(job.dedupeKey, job.commenterId);
    }
    // Anything else keeps its claim: Meta has told us this send can never work,
    // and re-attempting it would only re-learn that.

    console.error(`send failed permanently (${result.status}):`, result.error);
    return this.settle(job, "failed", result.error);
  }

  /** Puts a job back with the next backoff on it, and makes sure we wake for it. */
  private async defer(job: SendJob, attempts: number, why: string): Promise<string> {
    const next = attempts + 1;
    const delay = RETRY_DELAYS_MS[attempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    const dueAt = Date.now() + delay;

    this.ctx.storage.sql.exec(
      `INSERT INTO outbox (campaign_id, comment_id, job, attempts, due_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (campaign_id, comment_id) DO UPDATE SET
         attempts = excluded.attempts, due_at = excluded.due_at`,
      job.campaignId,
      job.commentId,
      JSON.stringify(job),
      next,
      dueAt,
    );
    await this.wakeAt(dueAt);
    console.error(
      `${why} — retry ${next}/${MAX_ATTEMPTS - 1} in ${Math.round(delay / 1000)}s`,
    );
    return "queued";
  }

  /** Drops a job from the outbox — settled, whether by a confirmed send or by
   *  giving up. After this the job can never be drained again. */
  private forget(job: SendJob): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM outbox WHERE campaign_id = ? AND comment_id = ?`,
      job.campaignId,
      job.commentId,
    );
  }

  /** Writes one outcome to the send log. Separate from forget() so the success
   *  path can drop the outbox row first and swallow a bookkeeping failure. */
  private async record(job: SendJob, status: string, error?: string): Promise<void> {
    await db.recordSend(this.env.DB, {
      campaignId: job.campaignId,
      igUserId: job.igUserId,
      commentId: job.commentId,
      commenterId: job.commenterId,
      commenterUsername: job.commenterUsername,
      mediaId: job.mediaId,
      status,
      error,
    });
  }

  /** Settles a job that never delivered: drop it, then log why. A D1 failure
   *  here reaches drain, which retries — safe, because nothing was sent. */
  private async settle(job: SendJob, status: string, error?: string): Promise<string> {
    this.forget(job);
    await this.record(job, status, error);
    return status;
  }

  private async drain(): Promise<void> {
    const due = this.ctx.storage.sql
      .exec<OutboxRow>(
        `SELECT job, attempts FROM outbox WHERE due_at <= ? ORDER BY due_at LIMIT ?`,
        Date.now(),
        DRAIN_LIMIT,
      )
      .toArray();

    for (const row of due) {
      // A job serialized before dedupeKey existed doesn't carry one, and it
      // claimed under the campaign id. Restoring that here keeps a retry across
      // a deploy releasing the claim it actually took.
      const stored = JSON.parse(row.job) as SendJob & { dedupeKey?: string; kind?: SendJob["kind"] };
      const job: SendJob = {
        ...stored,
        dedupeKey: stored.dedupeKey ?? stored.campaignId,
        // Everything queued before story replies existed was a private reply.
        kind: stored.kind ?? "private_reply",
      };
      try {
        await this.attempt(job, row.attempts);
      } catch (cause) {
        // A D1 blip shouldn't wedge the queue. Left as-is the job would still be
        // due, the alarm would throw again on the next retry, and eventually stop
        // being rescheduled at all — taking the dedupe prune down with it.
        if (row.attempts + 1 < MAX_ATTEMPTS) await this.defer(job, row.attempts, `${cause}`);
        else await this.settle(job, "failed", `${cause}`.slice(0, 300));
      }
    }
  }

  private async prune(): Promise<void> {
    const dueAt = await this.ctx.storage.get<number>(PRUNE_DUE_KEY);
    if (dueAt !== undefined && Date.now() < dueAt) return;

    const cutoff = Date.now() - PRUNE_AFTER_MS;
    const cursor = this.ctx.storage.sql.exec(`DELETE FROM seen WHERE sent_at < ?`, cutoff);
    if (cursor.rowsWritten > 0) {
      console.log(`pruned ${cursor.rowsWritten} expired dedupe rows`);
    }
    await this.ctx.storage.put(PRUNE_DUE_KEY, Date.now() + PRUNE_INTERVAL_MS);
  }

  /** Pulls the alarm earlier if a retry is due before whatever it was set for. */
  private async wakeAt(when: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || when < current) await this.ctx.storage.setAlarm(when);
  }

  private async scheduleNext(): Promise<void> {
    const [row] = this.ctx.storage.sql
      .exec<{ due: number | null }>(`SELECT MIN(due_at) AS due FROM outbox`)
      .toArray();
    const pruneAt =
      (await this.ctx.storage.get<number>(PRUNE_DUE_KEY)) ?? Date.now() + PRUNE_INTERVAL_MS;
    await this.ctx.storage.setAlarm(Math.min(row?.due ?? pruneAt, pruneAt));
  }
}
