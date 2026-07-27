import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendJob } from "../../src/account-do";
import * as db from "../../src/db";
import { IG_USER_ID } from "../fixtures";

/**
 * What the Durable Object does with a send Meta refused.
 *
 * The decision is which of three things a failure means: try again later, give
 * up but let someone else try, or give up and hold the claim so nobody retries.
 * Getting it wrong either burns a one-shot private reply on a call that can
 * never work, or permanently blocks a commenter over a rate limit that cleared
 * a minute later. HTTP status alone can't tell them apart — Meta returns most
 * rate limits as 400 — so the classification runs on the error code.
 */

const CAMPAIGN = "cmp_free_guide";
const COMMENT = "17900000000000042";
const COMMENTER = "78901234567890123";
const DEDUPE_KEY = `${CAMPAIGN}:${COMMENT}`;

let calls: string[] = [];

const graph = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fails the send, then lets anything else (the public reply) succeed. */
function stubMeta(send: () => Response) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : String(input);
      calls.push(url);
      if (url.endsWith("/replies")) return graph(200, { id: "reply_1" });
      return send();
    }),
  );
}

const ok = () => graph(200, { message_id: "mid_sent" });
const refusal = (status: number, code: number, message: string) =>
  graph(status, { error: { code, type: "OAuthException", message } });

function account(suffix: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(`${IG_USER_ID}-${suffix}`));
}

function job(over: Partial<SendJob> = {}): SendJob {
  return {
    igUserId: IG_USER_ID,
    campaignId: CAMPAIGN,
    kind: "private_reply",
    dedupeKey: DEDUPE_KEY,
    commentId: COMMENT,
    commenterId: COMMENTER,
    commenterUsername: "someone",
    message: "here you go",
    successStatus: "sent",
    ...over,
  };
}

async function sends() {
  const { results } = await env.DB.prepare(
    `SELECT status, error FROM sends WHERE comment_id = ?`,
  )
    .bind(COMMENT)
    .all<{ status: string; error: string | null }>();
  return results;
}

const flagged = async () =>
  (await env.DB.prepare(`SELECT needs_reconnect AS n FROM accounts WHERE ig_user_id = ?`)
    .bind(IG_USER_ID)
    .first<{ n: number }>())?.n === 1;

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM sends`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "cash.builds",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountDO send failures", () => {
  it("records the send and keeps nothing pending when Meta accepts it", async () => {
    const acc = account("success");
    await acc.claim(DEDUPE_KEY, COMMENTER);
    stubMeta(ok);

    expect(await acc.deliver(job())).toBe("sent");
    expect(await acc.pendingCommentIds()).toEqual([]);
    expect(await acc.count()).toBe(1);
    expect(await sends()).toEqual([{ status: "sent", error: null }]);
  });

  /**
   * 80007 is Instagram's messaging rate limit and arrives as a 400. Treating the
   * status as the signal would give up on a message that only needed a minute.
   */
  it("queues a retry and holds the claim on a rate limit", async () => {
    const acc = account("rate-limit");
    await acc.claim(DEDUPE_KEY, COMMENTER);
    stubMeta(() => refusal(400, 80007, "Rate limit exceeded"));

    expect(await acc.deliver(job())).toBe("queued");
    expect(await acc.pendingCommentIds()).toEqual([COMMENT]);
    // The claim stays: this send is still on its way, and releasing it would let
    // a redelivery spend a second private reply on the same commenter.
    expect(await acc.count()).toBe(1);
    // Nothing settled yet, so nothing is written to the log.
    expect(await sends()).toEqual([]);
  });

  /**
   * The token, not the message. Flag the account so the dashboard asks for a
   * reconnect, and let the claim go — the comment is still inside its 7-day
   * window, so the lead is recoverable once a human fixes the token.
   */
  it("flags the account and releases the claim when the token is refused", async () => {
    const acc = account("auth");
    await acc.claim(DEDUPE_KEY, COMMENTER);
    stubMeta(() => refusal(400, 190, "Error validating access token"));

    expect(await acc.deliver(job())).toBe("failed");
    expect(await flagged()).toBe(true);
    expect(await acc.count()).toBe(0);
    expect(await acc.pendingCommentIds()).toEqual([]);
    expect((await sends())[0].status).toBe("failed");
  });

  /**
   * A deleted comment, a recipient who can't be messaged. Meta has said this can
   * never work, so the claim is kept deliberately — retrying would only re-learn
   * it, and against a one-shot reply that costs more than giving up.
   */
  it("keeps the claim when Meta says the send can never work", async () => {
    const acc = account("permanent");
    await acc.claim(DEDUPE_KEY, COMMENTER);
    stubMeta(() => refusal(400, 100, "Invalid parameter"));

    expect(await acc.deliver(job())).toBe("failed");
    expect(await acc.count()).toBe(1);
    expect(await flagged()).toBe(false);
    expect(await acc.pendingCommentIds()).toEqual([]);
  });

  it("fails without calling Meta when the account has no usable token", async () => {
    const acc = account("no-token");
    await acc.claim(DEDUPE_KEY, COMMENTER);
    stubMeta(ok);
    await env.DB.prepare(`DELETE FROM accounts`).run();

    expect(await acc.deliver(job())).toBe("failed");
    expect(calls).toEqual([]);
    expect(await acc.count()).toBe(0);
    expect((await sends())[0].error).toMatch(/reconnect/i);
  });

  /** Pointing publicly at a DM that never arrived is worse than saying nothing. */
  it("does not post the public reply when the send failed", async () => {
    const acc = account("no-public-reply");
    await acc.claim(DEDUPE_KEY, COMMENTER);
    stubMeta(() => refusal(400, 100, "Invalid parameter"));

    await acc.deliver(job({ publicReply: "check your DMs" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/messages");
  });

  it("posts the public reply only behind a confirmed send", async () => {
    const acc = account("public-reply");
    await acc.claim(DEDUPE_KEY, COMMENTER);
    stubMeta(ok);

    await acc.deliver(job({ publicReply: "check your DMs" }));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/messages");
    expect(calls[1]).toContain(`/${COMMENT}/replies`);
  });

  /**
   * A queued retry must not also queue the public reply twice, and a rate-limited
   * send has posted nothing publicly yet.
   */
  it("holds the public reply back while the send is still being retried", async () => {
    const acc = account("queued-public-reply");
    await acc.claim(DEDUPE_KEY, COMMENTER);
    stubMeta(() => refusal(400, 4, "Application request limit reached"));

    expect(await acc.deliver(job({ publicReply: "check your DMs" }))).toBe("queued");
    expect(calls).toHaveLength(1);
  });

  /**
   * A story reply is answered as an ordinary DM, addressed to the sender rather
   * than to a comment. Same retry rules, different recipient.
   */
  it("addresses a dm to the recipient rather than to a comment", async () => {
    const acc = account("dm");
    const bodies: string[] = [];
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(input instanceof URL ? input.toString() : String(input));
        bodies.push(String(init?.body ?? ""));
        return ok();
      }),
    );

    await acc.deliver(job({ kind: "dm", recipientId: COMMENTER, successStatus: "sent" }));

    expect(JSON.parse(bodies[0]).recipient).toEqual({ id: COMMENTER });
  });
});
