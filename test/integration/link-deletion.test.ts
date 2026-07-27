import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

const CAMPAIGN_NAME = "Free guide";

let linkId: string;
let campaignId: string;

beforeEach(async () => {
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "an_account",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });

  linkId = db.newId();
  await db.saveLink(env.DB, {
    id: linkId,
    code: db.newLinkCode(),
    targetUrl: "https://example.com/free-guide",
  });

  campaignId = db.newId();
  await db.saveCampaign(env.DB, {
    id: campaignId,
    igUserId: IG_USER_ID,
    name: CAMPAIGN_NAME,
    mediaId: null,
    keywords: ["link"],
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

const linkExists = async (id: string) =>
  (await db.getLink(env.DB, id)) !== null;

describe("deleteLink", () => {
  /**
   * Detaching instead of refusing would leave the campaign sending a DM that
   * promises a link and ships without one — a break nobody would notice until
   * the leads stopped converting.
   */
  it("refuses while a campaign still references the link, and names it", async () => {
    const result = await db.deleteLink(env.DB, linkId);

    expect(result).toEqual({ ok: false, usedBy: CAMPAIGN_NAME });
    expect(await linkExists(linkId)).toBe(true);
  });

  it("allows the delete once the campaign points elsewhere", async () => {
    const campaign = await db.getCampaign(env.DB, campaignId);
    await db.saveCampaign(env.DB, { ...campaign!, linkId: null });

    expect(await db.deleteLink(env.DB, linkId)).toEqual({ ok: true });
    expect(await linkExists(linkId)).toBe(false);
  });

  it("allows the delete once the campaign is gone", async () => {
    await db.deleteCampaign(env.DB, campaignId);

    expect(await db.deleteLink(env.DB, linkId)).toEqual({ ok: true });
    expect(await linkExists(linkId)).toBe(false);
  });

  it("deletes a link no campaign ever used", async () => {
    const orphanId = db.newId();
    await db.saveLink(env.DB, {
      id: orphanId,
      code: db.newLinkCode(),
      targetUrl: "https://example.com/orphan",
    });

    expect(await db.deleteLink(env.DB, orphanId)).toEqual({ ok: true });
    expect(await linkExists(orphanId)).toBe(false);
    // The referenced one is untouched.
    expect(await linkExists(linkId)).toBe(true);
  });

  it("still refuses when the campaign using it is paused", async () => {
    const campaign = await db.getCampaign(env.DB, campaignId);
    await db.saveCampaign(env.DB, { ...campaign!, active: false });

    expect(await db.deleteLink(env.DB, linkId)).toEqual({ ok: false, usedBy: CAMPAIGN_NAME });
    expect(await linkExists(linkId)).toBe(true);
  });
});

describe("POST /links/:id/delete", () => {
  async function postDelete(id: string): Promise<Response> {
    const cookie = sessionCookie(await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD));
    const request = new Request(`https://freeply.test/links/${id}/delete`, {
      method: "POST",
      headers: { cookie: cookie.split(";")[0] },
      body: new FormData(),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("sends the operator back with an error naming the campaign", async () => {
    const response = await postDelete(linkId);
    const location = response.headers.get("location") ?? "";

    expect(response.status).toBe(302);
    expect(location.startsWith("/?tab=links&error=")).toBe(true);
    expect(decodeURIComponent(location)).toContain(CAMPAIGN_NAME);
    expect(await linkExists(linkId)).toBe(true);
  });

  it("redirects without an error once nothing uses the link", async () => {
    await db.deleteCampaign(env.DB, campaignId);

    const response = await postDelete(linkId);
    expect(response.headers.get("location")).toBe("/?tab=links");
    expect(await linkExists(linkId)).toBe(false);
  });

  // The dashboard holds Instagram tokens; every mutating route sits behind the
  // session gate, not just the ones that read.
  it("requires a session", async () => {
    const request = new Request(`https://freeply.test/links/${linkId}/delete`, {
      method: "POST",
      body: new FormData(),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
    expect(await linkExists(linkId)).toBe(true);
  });
});
