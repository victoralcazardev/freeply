import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../../src/db";
import { refreshStaleAccountMedia } from "../../src/index";
import { IG_USER_ID } from "../fixtures";

/**
 * Discovery is the half of the hourly sweep that finds posts published since
 * the last dashboard visit. Stats refresh only covers posts already cached, so
 * without this an account nobody looks at accumulates invisible posts — the
 * exact failure: two days of posts missing because the campaigns tab (the only
 * other writer of account_media) hadn't been opened.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Graph /me/media calls observed by the stub. */
let listReads = 0;

function stubMeta(mediaIds: string[]) {
  listReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      if (url.pathname.endsWith("/me/media")) listReads++;
      return new Response(
        JSON.stringify({
          data: mediaIds.map((id, i) => ({
            id,
            caption: `caption ${id}`,
            media_type: "VIDEO",
            permalink: `https://instagram.com/p/${id}`,
            timestamp: new Date(2_000_000 + i).toISOString(),
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

async function account(over: Partial<{ igUserId: string; needsReconnect: boolean }> = {}) {
  const igUserId = over.igUserId ?? IG_USER_ID;
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId,
    username: `user-${igUserId}`,
    accessToken: `IGAA-token-${igUserId}`,
    expiresIn: 60 * 24 * 60 * 60,
  });
  if (over.needsReconnect) await db.markNeedsReconnect(env.DB, igUserId, "test");
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM account_media`).run();
  await env.DB.prepare(`DELETE FROM settings`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
});

afterEach(() => vi.unstubAllGlobals());

describe("refreshStaleAccountMedia", () => {
  it("discovers posts for an account that has never been read", async () => {
    await account();
    stubMeta(["new-post"]);

    await refreshStaleAccountMedia(env as never, HOUR_MS);

    const media = await db.listAccountMedia(env.DB, IG_USER_ID);
    expect(media.map((m) => m.mediaId)).toEqual(["new-post"]);
    expect(listReads).toBe(1);
  });

  it("leaves a freshly-read account alone", async () => {
    await account();
    await db.saveAccountMedia(env.DB, IG_USER_ID, []); // stamps mediaCheckedAt = now
    stubMeta(["new-post"]);

    await refreshStaleAccountMedia(env as never, HOUR_MS);

    expect(listReads).toBe(0);
  });

  it("re-reads once the stamp ages past the window", async () => {
    await account();
    await db.saveAccountMedia(env.DB, IG_USER_ID, []);
    // Backdate the read stamp two hours — an hourly window must see it as due.
    await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = ?`)
      .bind(String(Date.now() - 2 * HOUR_MS), `media_checked:${IG_USER_ID}`)
      .run();
    stubMeta(["late-post"]);

    await refreshStaleAccountMedia(env as never, HOUR_MS);

    expect(listReads).toBe(1);
    expect((await db.listAccountMedia(env.DB, IG_USER_ID)).map((m) => m.mediaId)).toEqual([
      "late-post",
    ]);
  });

  it("skips an account flagged for reconnection", async () => {
    await account({ needsReconnect: true });
    stubMeta(["unreachable"]);

    await refreshStaleAccountMedia(env as never, HOUR_MS);

    expect(listReads).toBe(0);
    expect(await db.listAccountMedia(env.DB, IG_USER_ID)).toEqual([]);
  });
});
