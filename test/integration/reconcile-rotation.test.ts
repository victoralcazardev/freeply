import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "../../src/cron";
import * as db from "../../src/db";

/**
 * Reconciliation polls a bounded slice of accounts per run — the subrequest
 * budget won't survive an unbounded loop — and rotates through the list so the
 * accounts left out of one run lead the next. Without the rotation, ordering by
 * username silently means accounts after the fifth are never polled at all, and
 * a missed webhook there is a lead that expires at 7 days.
 *
 * The cap is 5 (MAX_ACCOUNTS_PER_RUN), so these use 7 accounts to make a run
 * that has to leave someone out.
 */

const NAMES = ["a", "b", "c", "d", "e", "f", "g"];
const igUserId = (name: string) => `1784140000000000${NAMES.indexOf(name)}`;
const mediaFor = (name: string) => `media-${name}`;

/** Media ids polled this run, in order, read out of the Graph URLs. */
let polled: string[] = [];

function stubMeta() {
  polled = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      const [, , mediaId] = url.pathname.split("/");
      if (url.pathname.endsWith("/comments")) polled.push(mediaId);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

/** An account with one active campaign pinned to its own post, so the run polls
 *  exactly one known media id per account and never asks for recent media. */
async function accountWithCampaign(name: string, over: { active?: boolean } = {}) {
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: igUserId(name),
    username: name,
    accessToken: `IGAA-token-${name}`,
    expiresIn: 60 * 24 * 60 * 60,
  });
  await db.saveCampaign(env.DB, {
    id: db.newId(),
    igUserId: igUserId(name),
    name: `campaign ${name}`,
    mediaId: mediaFor(name),
    keywords: ["link"],
    matchMode: "whole_word",
    dedupeScope: "per_post",
    storyReplies: false,
    iceBreaker: null,
    dmMessage: "here you go",
    publicReply: null,
    linkId: null,
    active: over.active ?? true,
  });
}

async function seed(count: number) {
  for (const name of NAMES.slice(0, count)) await accountWithCampaign(name);
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM campaigns`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  await env.DB.prepare(`DELETE FROM settings`).run();
  stubMeta();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconciliation account rotation", () => {
  it("polls at most five accounts and leaves the cursor on the next one", async () => {
    await seed(7);

    await reconcile(env);

    expect(polled).toEqual(["a", "b", "c", "d", "e"].map(mediaFor));
    expect(await db.getReconcileCursor(env.DB)).toBe(5);
  });

  /**
   * The point of the cursor. Run two has to start where run one stopped, or f
   * and g are never polled and their missed webhooks expire unrecovered.
   */
  it("gives the accounts a run left out the front of the next one", async () => {
    await seed(7);

    await reconcile(env);
    const first = [...polled];
    stubMeta();
    await reconcile(env);

    expect(first).toEqual(["a", "b", "c", "d", "e"].map(mediaFor));
    expect(polled).toEqual(["f", "g", "a", "b", "c"].map(mediaFor));
    expect(await db.getReconcileCursor(env.DB)).toBe(3);
  });

  it("wraps rather than running off the end of the list", async () => {
    await seed(7);
    await db.setReconcileCursor(env.DB, 6);

    await reconcile(env);

    expect(polled).toEqual(["g", "a", "b", "c", "d"].map(mediaFor));
    expect(await db.getReconcileCursor(env.DB)).toBe(4);
  });

  /** Accounts get disconnected. A cursor past the end must not skip the run. */
  it("recovers from a cursor left past the end of a shrunken list", async () => {
    await seed(3);
    await db.setReconcileCursor(env.DB, 99);

    await reconcile(env);

    expect(polled).toEqual(["a", "b", "c"].map(mediaFor));
    expect(await db.getReconcileCursor(env.DB)).toBe(0);
  });

  /**
   * The cursor is persisted before the work, not after. The budget it guards
   * against is exactly what could stop a run reaching an "after", and a cursor
   * that only moved on success would retry the same head forever.
   */
  it("advances even when every account in the slice does no work", async () => {
    await seed(7);
    // No usable token for anyone: each account is skipped inside the loop.
    await env.DB.prepare(`UPDATE accounts SET token_encrypted = 'not-decryptable'`).run();

    await reconcile(env);

    expect(polled).toEqual([]);
    expect(await db.getReconcileCursor(env.DB)).toBe(5);
  });

  it("leaves the cursor alone when no account has an active campaign", async () => {
    await accountWithCampaign("a", { active: false });
    await db.setReconcileCursor(env.DB, 2);

    await reconcile(env);

    expect(polled).toEqual([]);
    expect(await db.getReconcileCursor(env.DB)).toBe(2);
  });

  it("skips an account already flagged for reconnect", async () => {
    await seed(3);
    await db.markNeedsReconnect(env.DB, igUserId("b"), "token revoked");

    await reconcile(env);

    expect(polled).toEqual(["a", "c"].map(mediaFor));
  });
});
