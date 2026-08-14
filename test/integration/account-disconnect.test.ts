import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * Disconnecting used to DELETE the account row, and campaigns.ig_user_id
 * ON DELETE CASCADE (migration 0001) took every campaign for that account with
 * it — silent, since reconnecting just inserts a fresh row rather than
 * reviving the deleted one. Migration 0014 stops the row from ever being
 * deleted, so this is what should never regress again.
 */

let campaignId: string;
let linkId: string;

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM campaigns`).run();
  await env.DB.prepare(`DELETE FROM links`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();

  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "cash.builds",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });

  linkId = db.newId();
  await db.saveLink(env.DB, {
    id: linkId,
    code: db.newLinkCode(),
    targetUrl: "https://ig.chrisjk.com",
    tracked: true,
  });

  campaignId = db.newId();
  await db.saveCampaign(env.DB, {
    id: campaignId,
    igUserId: IG_USER_ID,
    name: "iOS",
    mediaId: null,
    keywords: ["iOS"],
    matchMode: "whole_word",
    dedupeScope: "per_post",
    storyReplies: false,
    iceBreaker: null,
    dmMessage: "Here it is: {link}",
    publicReply: null,
    linkId,
    active: true,
  });
});

async function disconnect(): Promise<Response> {
  const cookie = sessionCookie(await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD));
  const request = new Request(`https://freeply.test/accounts/${IG_USER_ID}/delete`, {
    method: "POST",
    headers: { cookie: cookie.split(";")[0] },
    body: new FormData(),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("disconnecting an account", () => {
  it("deactivates its campaigns instead of deleting them", async () => {
    await disconnect();

    const campaign = await db.getCampaign(env.DB, campaignId);
    expect(campaign).not.toBeNull();
    expect(campaign?.active).toBe(false);
    // The link it pointed at is untouched — no cascade to it either.
    expect((await db.getLink(env.DB, linkId))?.targetUrl).toBe("https://ig.chrisjk.com");
  });

  it("marks the account disconnected rather than removing its row", async () => {
    await disconnect();

    const accounts = await db.listAccounts(env.DB);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].disconnectedAt).not.toBeNull();
  });

  it("clears the disconnected flag on reconnect, leaving campaigns for the operator to re-enable", async () => {
    await disconnect();

    await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
      igUserId: IG_USER_ID,
      username: "cash.builds",
      accessToken: "IGAA-new-token-after-reconnect",
      expiresIn: 60 * 24 * 60 * 60,
    });

    const accounts = await db.listAccounts(env.DB);
    expect(accounts[0].disconnectedAt).toBeNull();

    // Still there, still off — reconnecting restores access, not the campaign.
    const campaign = await db.getCampaign(env.DB, campaignId);
    expect(campaign).not.toBeNull();
    expect(campaign?.active).toBe(false);
  });

  it("excludes a disconnected account from token-refresh scheduling", async () => {
    await disconnect();

    const due = await db.accountsDueForRefresh(env.DB, Date.now() + 365 * 86_400_000);
    expect(due.find((a) => a.igUserId === IG_USER_ID)).toBeUndefined();
  });
});
