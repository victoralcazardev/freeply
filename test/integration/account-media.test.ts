import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../../src/db";
import { IG_USER_ID } from "../fixtures";

const OTHER_ACCOUNT = "17841400000000002";

function post(mediaId: string, postedAt: number) {
  return {
    mediaId,
    caption: `caption ${mediaId}`,
    thumbnailUrl: `https://cdn.test/${mediaId}.jpg`,
    permalink: `https://instagram.com/p/${mediaId}`,
    mediaType: "IMAGE",
    postedAt,
  };
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM account_media`).run();
  await env.DB.prepare(`DELETE FROM settings`).run();
});

describe("account media cache", () => {
  it("lists what was saved, newest post first", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [post("older", 1_000), post("newer", 2_000)]);

    const media = await db.listAccountMedia(env.DB, IG_USER_ID);
    expect(media.map((m) => m.mediaId)).toEqual(["newer", "older"]);
    expect(media[0].caption).toBe("caption newer");
    expect(media[0].thumbnailUrl).toBe("https://cdn.test/newer.jpg");
  });

  // A post deleted on Instagram shouldn't stay in a list offering current posts.
  it("drops posts the latest read didn't return", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [post("kept", 2_000), post("deleted", 1_000)]);
    await db.saveAccountMedia(env.DB, IG_USER_ID, [post("kept", 2_000)]);

    expect((await db.listAccountMedia(env.DB, IG_USER_ID)).map((m) => m.mediaId)).toEqual(["kept"]);
  });

  it("keeps accounts apart", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [post("mine", 1_000)]);
    await db.saveAccountMedia(env.DB, OTHER_ACCOUNT, [post("theirs", 1_000)]);

    expect((await db.listAccountMedia(env.DB, IG_USER_ID)).map((m) => m.mediaId)).toEqual(["mine"]);
    expect((await db.listAccountMedia(env.DB, OTHER_ACCOUNT)).map((m) => m.mediaId)).toEqual([
      "theirs",
    ]);
  });

  /**
   * The marker is what stops an account with no posts being re-read from Meta
   * every time the campaign form is opened — there are no rows to date it by.
   */
  it("records the read even when the account has no posts", async () => {
    expect(await db.mediaCheckedAt(env.DB, IG_USER_ID)).toBeNull();
    expect(db.cacheIsStale(await db.mediaCheckedAt(env.DB, IG_USER_ID))).toBe(true);

    await db.saveAccountMedia(env.DB, IG_USER_ID, []);

    const checkedAt = await db.mediaCheckedAt(env.DB, IG_USER_ID);
    expect(checkedAt).not.toBeNull();
    expect(db.cacheIsStale(checkedAt)).toBe(false);
  });

  it("marks only the account it read", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [post("mine", 1_000)]);

    expect(await db.mediaCheckedAt(env.DB, OTHER_ACCOUNT)).toBeNull();
  });
});
