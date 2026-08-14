import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../../src/db";
import { IG_USER_ID } from "../fixtures";

/**
 * The time series and the editorial layer (2026-08-12).
 *
 * The interesting behaviour is the insert guard: `post_stats` is upserted every
 * sweep, but history must only grow when a number actually moved, or a settled
 * post would accrue an identical row every hour forever. NULL handling is the
 * sharp edge — these columns are routinely null, and `NULL = NULL` is NULL, so a
 * guard written with `=` instead of `IS` would look correct and insert a
 * duplicate on every single sweep.
 */

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
    permalink: "https://www.instagram.com/reel/ABC123/",
    caption: "caption",
    thumbnailUrl: null,
    mediaType: "VIDEO",
    ...overrides,
  };
}

async function addMedia(mediaId: string, postedAt: number, permalink: string) {
  await env.DB.prepare(
    `INSERT INTO account_media (media_id, ig_user_id, caption, thumbnail_url,
       permalink, media_type, posted_at, fetched_at)
     VALUES (?, ?, NULL, NULL, ?, 'VIDEO', ?, ?)`,
  )
    .bind(mediaId, IG_USER_ID, permalink, postedAt, Date.now())
    .run();
}

const countSnapshots = async (mediaId: string) =>
  (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM post_stats_history WHERE media_id = ?`)
      .bind(mediaId)
      .first<{ n: number }>()
  )?.n ?? 0;

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM post_stats_history`).run();
  await env.DB.prepare(`DELETE FROM post_notes`).run();
  await env.DB.prepare(`DELETE FROM post_stats`).run();
  await env.DB.prepare(`DELETE FROM account_media`).run();
});

describe("post_stats_history", () => {
  it("records a snapshot on the first sweep", async () => {
    await addMedia("m1", Date.now() - 3_600_000, "https://www.instagram.com/reel/ABC123/");
    await db.savePostStats(env.DB, "m1", stats());
    expect(await countSnapshots("m1")).toBe(1);
  });

  // These drive appendStatsSnapshot with EXPLICIT, distinct timestamps rather
  // than going through savePostStats. Two savePostStats calls in a test land in
  // the same millisecond, where the (media_id, observed_at) upsert collapses them
  // into one row — so a guard test written that way would report "1 row" and pass
  // whether or not the change guard works at all. Distinct stamps are what make
  // these assertions mean something.
  const snap = (over: Record<string, number | null> = {}) => ({
    views: 250, reach: 100, skipRate: 41.5, avgWatchMs: 6200,
    totalWatchMs: 1_000_000, interactions: 11,
    likes: 5, comments: 2, saved: 3, shares: 1,
    ...over,
  });

  it("does not record a second snapshot when nothing moved", async () => {
    const t = Date.now();
    await addMedia("m1", t - 3_600_000, "https://www.instagram.com/reel/ABC123/");
    await db.appendStatsSnapshot(env.DB, "m1", t, snap());
    await db.appendStatsSnapshot(env.DB, "m1", t + 1000, snap());
    await db.appendStatsSnapshot(env.DB, "m1", t + 2000, snap());
    expect(await countSnapshots("m1")).toBe(1);
  });

  it("records a snapshot when any single metric moves", async () => {
    const t = Date.now();
    await addMedia("m1", t - 3_600_000, "https://www.instagram.com/reel/ABC123/");
    await db.appendStatsSnapshot(env.DB, "m1", t, snap());
    await db.appendStatsSnapshot(env.DB, "m1", t + 1000, snap({ views: 251 }));
    expect(await countSnapshots("m1")).toBe(2);
  });

  // The NULL trap. A reel whose "in development" metrics drop out reports null
  // twice running; with `=` in the guard instead of `IS`, that inserts twice —
  // and it would do so on EVERY sweep for every post missing a metric, which is
  // most of them.
  it("treats two identical all-null readings as unchanged", async () => {
    const t = Date.now();
    await addMedia("m1", t - 3_600_000, "https://www.instagram.com/reel/ABC123/");
    const nulled = snap({ skipRate: null, avgWatchMs: null, views: null });
    await db.appendStatsSnapshot(env.DB, "m1", t, nulled);
    await db.appendStatsSnapshot(env.DB, "m1", t + 1000, nulled);
    expect(await countSnapshots("m1")).toBe(1);
  });

  it("records a snapshot when a metric drops out to null", async () => {
    const t = Date.now();
    await addMedia("m1", t - 3_600_000, "https://www.instagram.com/reel/ABC123/");
    await db.appendStatsSnapshot(env.DB, "m1", t, snap());
    await db.appendStatsSnapshot(env.DB, "m1", t + 1000, snap({ skipRate: null }));
    expect(await countSnapshots("m1")).toBe(2);
  });

  // The guard compares against the LATEST snapshot only, so a metric that moves
  // and moves back must still record both transitions — otherwise a post that
  // oscillates looks flat.
  it("records a return to a previously-seen value", async () => {
    const t = Date.now();
    await addMedia("m1", t - 3_600_000, "https://www.instagram.com/reel/ABC123/");
    await db.appendStatsSnapshot(env.DB, "m1", t, snap({ views: 100 }));
    await db.appendStatsSnapshot(env.DB, "m1", t + 1000, snap({ views: 200 }));
    await db.appendStatsSnapshot(env.DB, "m1", t + 2000, snap({ views: 100 }));
    expect(await countSnapshots("m1")).toBe(3);
  });

  // Found by the existing suite, not by inspection: two sweeps of one post inside
  // the same millisecond collide on (media_id, observed_at). The guard lets the
  // insert through because a metric genuinely changed, and the PK then throws —
  // which would abort the whole sweep, losing stats for every post after it. A
  // forced refresh landing on the same tick as the cron is the real-world case.
  it("survives two readings stamped the same millisecond, keeping the later one", async () => {
    await addMedia("m1", Date.now() - 3_600_000, "https://www.instagram.com/reel/ABC123/");
    const at = Date.now();
    const snap = (views: number) => ({
      views, reach: null, skipRate: null, avgWatchMs: null,
      likes: null, comments: null, saved: null, shares: null,
    });
    await db.appendStatsSnapshot(env.DB, "m1", at, snap(100));
    await expect(db.appendStatsSnapshot(env.DB, "m1", at, snap(200))).resolves.not.toThrow();

    expect(await countSnapshots("m1")).toBe(1);
    const row = await env.DB.prepare(
      `SELECT views FROM post_stats_history WHERE media_id = 'm1' AND observed_at = ?`,
    ).bind(at).first<{ views: number }>();
    expect(row?.views).toBe(200);
  });

  it("stamps age_ms from the post's own posted_at", async () => {
    const postedAt = Date.now() - 24 * 3_600_000;
    await addMedia("m1", postedAt, "https://www.instagram.com/reel/ABC123/");
    await db.savePostStats(env.DB, "m1", stats());
    const row = await env.DB.prepare(
      `SELECT age_ms FROM post_stats_history WHERE media_id = 'm1'`,
    ).first<{ age_ms: number }>();
    // Within a minute of 24h — the clock moves between the two statements.
    expect(Math.abs((row?.age_ms ?? 0) - 24 * 3_600_000)).toBeLessThan(60_000);
  });

  it("finds the reading nearest a requested age and omits posts outside tolerance", async () => {
    const postedAt = Date.now() - 48 * 3_600_000;
    await addMedia("m1", postedAt, "https://www.instagram.com/reel/ABC123/");
    // Three readings: 1h, 24h, 47h old.
    for (const [ageH, views] of [[1, 10], [24, 100], [47, 400]] as const) {
      await db.appendStatsSnapshot(env.DB, "m1", postedAt + ageH * 3_600_000, {
        views, reach: null, skipRate: null, avgWatchMs: null,
        likes: null, comments: null, saved: null, shares: null,
      });
      await env.DB.prepare(
        `UPDATE post_stats_history SET age_ms = ? WHERE media_id = 'm1' AND observed_at = ?`,
      ).bind(ageH * 3_600_000, postedAt + ageH * 3_600_000).run();
    }

    const at24 = await db.statsAtAge(env.DB, 24 * 3_600_000, 6 * 3_600_000);
    expect(at24).toHaveLength(1);
    expect((at24[0] as { views: number }).views).toBe(100);

    // Nothing sits within 2h of the 12h mark, so the post is omitted rather
    // than answered with its 1h or 24h reading.
    expect(await db.statsAtAge(env.DB, 12 * 3_600_000, 2 * 3_600_000)).toHaveLength(0);
  });
});

describe("post_notes", () => {
  it("attaches a judgement to the stats report by shortcode", async () => {
    await addMedia("m1", Date.now(), "https://www.instagram.com/reel/ABC123/");
    await db.savePostStats(env.DB, "m1", stats());
    await db.savePostNote(env.DB, "ABC123", {
      fmt: "walkie-talkie", status: "on-format", pill: "p-good", why: "reasoning",
    });

    const [row] = await db.postStatsReport(env.DB, 10);
    expect(row.note).toMatchObject({ fmt: "walkie-talkie", status: "on-format", pill: "p-good" });
  });

  it("leaves note null for an unjudged post", async () => {
    await addMedia("m1", Date.now(), "https://www.instagram.com/reel/ZZZ999/");
    await db.savePostStats(env.DB, "m1", stats({ permalink: "https://www.instagram.com/reel/ZZZ999/" }));
    const [row] = await db.postStatsReport(env.DB, 10);
    expect(row.note).toBeNull();
  });

  // A carousel is /p/, not /reel/ — the dashboard's own key had to handle both,
  // and a judgement that silently failed to attach would render "not judged yet".
  it("keys carousels off the /p/ permalink form", async () => {
    await addMedia("m1", Date.now(), "https://www.instagram.com/p/CAR0USEL/");
    await db.savePostStats(env.DB, "m1", stats({ permalink: "https://www.instagram.com/p/CAR0USEL/" }));
    await db.savePostNote(env.DB, "CAR0USEL", { fmt: "carousel", status: "s", pill: "p-mute", why: "w" });
    const [row] = await db.postStatsReport(env.DB, 10);
    expect((row.note as { fmt: string }).fmt).toBe("carousel");
  });

  it("re-judging a post replaces the verdict rather than duplicating it", async () => {
    await db.savePostNote(env.DB, "ABC123", { fmt: "f", status: "first", pill: "p-mute", why: "w" });
    await db.savePostNote(env.DB, "ABC123", { fmt: "f", status: "second", pill: "p-good", why: "w2" });
    const notes = await db.postNotes(env.DB);
    expect(Object.keys(notes)).toHaveLength(1);
    expect(notes.ABC123.status).toBe("second");
  });
});
