import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../../src/db";
import { IG_USER_ID } from "../fixtures";

function stats(overrides: Partial<Parameters<typeof db.savePostStats>[2]> = {}) {
  return {
    reach: 100,
    likes: 5,
    comments: 2,
    saved: 3,
    shares: 1,
    views: 250,
    skipRate: 41.5,
    avgWatchMs: 6200,
    permalink: "https://instagram.com/reel/x",
    caption: "caption",
    thumbnailUrl: null,
    mediaType: "VIDEO",
    ...overrides,
  };
}

function media(mediaId: string, postedAt: number) {
  return {
    mediaId,
    caption: null,
    thumbnailUrl: null,
    permalink: null,
    mediaType: "VIDEO",
    postedAt,
  };
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM post_stats`).run();
  await env.DB.prepare(`DELETE FROM account_media`).run();
  await env.DB.prepare(`DELETE FROM settings`).run();
});

describe("post stats cache", () => {
  it("round-trips the reel metrics, nulls included", async () => {
    await db.savePostStats(env.DB, "reel1", stats());
    // A photo never reports the reel-only pair; the columns must hold null.
    await db.savePostStats(
      env.DB,
      "photo1",
      stats({ skipRate: null, avgWatchMs: null, mediaType: "IMAGE" }),
    );

    const rows = await env.DB.prepare(
      `SELECT media_id, views, skip_rate, avg_watch_ms FROM post_stats ORDER BY media_id`,
    ).all<{ media_id: string; views: number; skip_rate: number | null; avg_watch_ms: number | null }>();

    expect(rows.results).toEqual([
      { media_id: "photo1", views: 250, skip_rate: null, avg_watch_ms: null },
      { media_id: "reel1", views: 250, skip_rate: 41.5, avg_watch_ms: 6200 },
    ]);
  });

  it("upserts rather than duplicating on refresh", async () => {
    await db.savePostStats(env.DB, "reel1", stats({ views: 100 }));
    await db.savePostStats(env.DB, "reel1", stats({ views: 300 }));

    const rows = await env.DB.prepare(`SELECT views FROM post_stats`).all<{ views: number }>();
    expect(rows.results).toEqual([{ views: 300 }]);
  });
});

describe("staleRecentMediaStats", () => {
  it("returns recent posts with no stats row, newest first", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [media("old", 1_000), media("new", 2_000)]);

    const stale = await db.staleRecentMediaStats(env.DB, 10);
    expect(stale.map((s) => s.mediaId)).toEqual(["new", "old"]);
    expect(stale[0].igUserId).toBe(IG_USER_ID);
  });

  it("excludes posts whose stats are fresh", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [media("covered", 2_000), media("bare", 1_000)]);
    await db.savePostStats(env.DB, "covered", stats());

    const stale = await db.staleRecentMediaStats(env.DB, 10);
    expect(stale.map((s) => s.mediaId)).toEqual(["bare"]);
  });

  it("honors the cap", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [
      media("a", 3_000), media("b", 2_000), media("c", 1_000),
    ]);

    const stale = await db.staleRecentMediaStats(env.DB, 2);
    expect(stale.map((s) => s.mediaId)).toEqual(["a", "b"]);
  });

  // The cron sweeps on a looser clock than the dashboard, so a row fresh by the
  // dashboard's TTL must still count as stale once it exceeds the caller's maxAge.
  it("honors a caller-supplied max age", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [media("aging", 1_000)]);
    await db.savePostStats(env.DB, "aging", stats());

    expect(await db.staleRecentMediaStats(env.DB, 10)).toEqual([]);
    expect(
      (await db.staleRecentMediaStats(env.DB, 10, -1)).map((s) => s.mediaId),
    ).toEqual(["aging"]);
  });
});
