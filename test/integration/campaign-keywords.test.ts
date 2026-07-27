import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../../src/db";
import { IG_USER_ID } from "../fixtures";

const base = {
  igUserId: IG_USER_ID,
  name: "Free guide",
  mediaId: null,
  matchMode: "contains" as const,
  dedupeScope: "per_post" as const,
  storyReplies: false,
  iceBreaker: null,
  dmMessage: "Here it is: {link}",
  publicReply: null,
  linkId: null,
  active: true,
};

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM campaigns`).run();
  // campaigns.ig_user_id is a foreign key, so the account has to exist first.
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "an_account",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
});

describe("campaign keywords", () => {
  it("round-trips the whole list, in order", async () => {
    const id = db.newId();
    await db.saveCampaign(env.DB, { ...base, id, keywords: ["link", "guide", "send me"] });

    expect((await db.getCampaign(env.DB, id))?.keywords).toEqual(["link", "guide", "send me"]);
    expect((await db.activeCampaignsFor(env.DB, IG_USER_ID))[0].keywords).toEqual([
      "link",
      "guide",
      "send me",
    ]);
  });

  it("survives a keyword containing the quotes JSON is made of", async () => {
    const id = db.newId();
    await db.saveCampaign(env.DB, { ...base, id, keywords: [`say "link"`, "back\\slash"] });

    expect((await db.getCampaign(env.DB, id))?.keywords).toEqual([`say "link"`, "back\\slash"]);
  });

  /**
   * The pre-0006 column is still written, and still read when the list is empty.
   * That is the shape of a row inserted by a Worker deployed before the list
   * existed — a campaign matching nothing at all would be a worse answer than
   * one matching the keyword it was created with.
   */
  it("falls back to the single-keyword column when the list is empty", async () => {
    const id = db.newId();
    await env.DB.prepare(
      `INSERT INTO campaigns
         (id, ig_user_id, name, media_id, keyword, match_mode, dm_message,
          public_reply, link_id, active, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, NULL, 1, ?)`,
    )
      .bind(id, IG_USER_ID, base.name, "link", base.matchMode, base.dmMessage, Date.now())
      .run();

    expect((await db.getCampaign(env.DB, id))?.keywords).toEqual(["link"]);
  });

  it("keeps the pre-list column pointed at the first keyword", async () => {
    const id = db.newId();
    await db.saveCampaign(env.DB, { ...base, id, keywords: ["link", "guide"] });

    const row = await env.DB.prepare(`SELECT keyword FROM campaigns WHERE id = ?`)
      .bind(id)
      .first<{ keyword: string }>();
    expect(row?.keyword).toBe("link");
  });
});
