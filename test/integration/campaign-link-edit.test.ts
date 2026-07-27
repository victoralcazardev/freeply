import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

const TARGET = "https://github.com/chris-jk/MioBio";

let linkId: string;
let campaignId: string;
let code: string;

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM campaigns`).run();
  await env.DB.prepare(`DELETE FROM links`).run();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "an_account",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });

  linkId = db.newId();
  code = db.newLinkCode();
  await db.saveLink(env.DB, { id: linkId, code, targetUrl: TARGET, tracked: true });

  campaignId = db.newId();
  await db.saveCampaign(env.DB, {
    id: campaignId,
    igUserId: IG_USER_ID,
    name: "bio app",
    mediaId: null,
    keywords: ["BIO"],
    matchMode: "contains",
    dedupeScope: "per_post",
    storyReplies: false,
    iceBreaker: null,
    dmMessage: "Here it is: {link}",
    publicReply: null,
    linkId,
    active: true,
  });
});

/** Submits the edit form the way the dashboard renders it, link field included. */
async function submitEdit(fields: Record<string, string>): Promise<Response> {
  const cookie = sessionCookie(await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD));
  const body = new FormData();
  for (const [k, v] of Object.entries({
    ig_user_id: IG_USER_ID,
    name: "bio app",
    keywords: "BIO",
    match_mode: "contains",
    dedupe_scope: "per_post",
    dm_message: "Here it is: {link}",
    public_reply: "",
    media_id: "",
    track_link: "yes",
    ...fields,
  })) {
    body.set(k, v);
  }

  const request = new Request(`https://freeply.test/campaigns/${campaignId}/update`, {
    method: "POST",
    headers: { cookie: cookie.split(";")[0] },
    body,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const linkCount = async () =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM links`).first<{ n: number }>())?.n ?? 0;

describe("editing a campaign's link", () => {
  /**
   * The form prefills the current URL, so an edit that only changed the name
   * still posts the link back unchanged. Minting a row for that is what left
   * three short codes pointing at one page, each holding part of the clicks.
   */
  it("reuses the existing link when the URL comes back unchanged", async () => {
    await submitEdit({ link_url: TARGET, name: "bio app renamed" });

    const campaign = await db.getCampaign(env.DB, campaignId);
    expect(campaign?.linkId).toBe(linkId);
    expect((await db.getLink(env.DB, linkId))?.code).toBe(code);
    expect(await linkCount()).toBe(1);
  });

  /** The prefilled value arrives normalized differently than it was typed. */
  it("treats a URL that only differs before normalizing as unchanged", async () => {
    await submitEdit({ link_url: "github.com/chris-jk/MioBio" });

    expect((await db.getCampaign(env.DB, campaignId))?.linkId).toBe(linkId);
    expect(await linkCount()).toBe(1);
  });

  it("applies a changed tracking choice to the link already there", async () => {
    await submitEdit({ link_url: TARGET, track_link: "no" });

    const link = await db.getLink(env.DB, linkId);
    expect(link?.tracked).toBe(false);
    expect(link?.code).toBe(code);
    expect(await linkCount()).toBe(1);
  });

  /**
   * A genuinely different destination still gets its own row — merging the two
   * would pool clicks for two different pages under one count.
   */
  it("creates a new link when the destination actually changes", async () => {
    await submitEdit({ link_url: "https://example.com/somewhere-else" });

    const campaign = await db.getCampaign(env.DB, campaignId);
    expect(campaign?.linkId).not.toBe(linkId);
    expect((await db.getLink(env.DB, campaign!.linkId!))?.targetUrl).toBe(
      "https://example.com/somewhere-else",
    );
    // The replaced one stays, with whatever clicks it had.
    expect(await linkCount()).toBe(2);
  });

  it("keeps the current link when the field is cleared", async () => {
    await submitEdit({ link_url: "" });

    expect((await db.getCampaign(env.DB, campaignId))?.linkId).toBe(linkId);
  });

  it("detaches the link when the remove checkbox is ticked", async () => {
    await submitEdit({ link_url: TARGET, remove_link: "1" });

    expect((await db.getCampaign(env.DB, campaignId))?.linkId).toBeNull();
  });
});

describe("the edit form", () => {
  it("shows the current URL in the field, not only in the label", async () => {
    const cookie = sessionCookie(await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD));
    const request = new Request(
      `https://freeply.test/?tab=campaigns&edit=${campaignId}`,
      { headers: { cookie: cookie.split(";")[0] } },
    );
    const ctx = createExecutionContext();
    const html = await (await worker.fetch(request, env, ctx)).text();
    await waitOnExecutionContext(ctx);

    expect(html).toContain(`name="link_url"`);
    expect(html).toContain(`value="${TARGET}"`);
  });
});
