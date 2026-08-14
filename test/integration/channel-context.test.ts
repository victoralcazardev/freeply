import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import * as db from "../../src/db";
import { IG_USER_ID } from "../fixtures";

const TOKEN = "channel-token-for-tests";

/** A second connected account, for the per-account split. */
const SECOND_ACCOUNT = "17841400000000002";

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://freeply.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

async function seedAccount(igUserId: string, username: string) {
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId,
    username,
    accessToken: "test-access-token",
    expiresIn: 3600,
  });
}

function run(req: Request, overrides: Partial<typeof env> = {}) {
  const ctx = createExecutionContext();
  return worker.fetch(req, { ...env, CHANNEL_TOKEN: TOKEN, ...overrides } as typeof env, ctx);
}

function post(mediaId: string, caption: string, postedAt: number) {
  return {
    mediaId,
    caption,
    thumbnailUrl: null,
    permalink: `https://www.instagram.com/reel/${mediaId}/`,
    mediaType: "VIDEO",
    postedAt,
  };
}

async function withStats(mediaId: string, views: number) {
  await env.DB.prepare(
    `INSERT INTO post_stats (media_id, views, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(media_id) DO UPDATE SET views = excluded.views`,
  )
    .bind(mediaId, views, Date.now())
    .run();
}

async function withFullStats(mediaId: string) {
  await env.DB.prepare(
    `INSERT INTO post_stats
       (media_id, reach, likes, comments, saved, shares, views, skip_rate,
        avg_watch_ms, thumbnail_url, media_type, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      mediaId,
      321,
      24,
      3,
      9,
      4,
      1234,
      0.42,
      5600,
      `https://cdn.test/${mediaId}-stats.jpg`,
      "VIDEO",
      Date.now(),
    )
    .run();
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM accounts`).run();
  await env.DB.prepare(`DELETE FROM account_media`).run();
  await env.DB.prepare(`DELETE FROM post_stats`).run();
  await env.DB.prepare(`DELETE FROM settings`).run();
  // "cash.builds" sorts before "second.brands", so the default (no `account`)
  // pack is deterministically the first account's.
  await seedAccount(IG_USER_ID, "cash.builds");
  await seedAccount(SECOND_ACCOUNT, "second.brands");
});

describe("channel endpoints", () => {
  it("404s when no channel token is configured", async () => {
    // Off should look like it was never built, not like a locked door.
    const res = await run(request("/channel/context"), { CHANNEL_TOKEN: undefined });
    expect(res.status).toBe(404);
  });

  it("401s on a wrong token", async () => {
    const res = await run(
      new Request("https://freeply.test/channel/context", {
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("401s with no authorization header at all", async () => {
    const res = await run(new Request("https://freeply.test/channel/context"));
    expect(res.status).toBe(401);
  });

  // The whole point of the endpoint: the app decodes this with Swift's
  // `.iso8601` strategy, which uses ISO8601DateFormatter's default options and
  // *rejects* fractional seconds. `Date.toISOString()` always emits them, so
  // getting this wrong makes every pack fail to decode at `generatedAt` — and
  // it surfaces in the app as "couldn't reach your channel".
  it("emits dates without fractional seconds", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [post("aaa", "hello #one", 1_750_000_000_000)]);

    const body = (await (await run(request("/channel/context"))).json()) as {
      generatedAt: string;
      referencePosts: Array<{ postedAt: string | null }>;
    };

    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(body.referencePosts[0].postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("splits hashtags out of the caption body", async () => {
    // Leaving tags inline would teach the model to write captions with tags
    // baked in, which every platform then positions wrong.
    await db.saveAccountMedia(env.DB, IG_USER_ID, [
      post("aaa", "Fifteen cents a day #claudecode #buildinpublic", 1_750_000_000_000),
    ]);

    const body = (await (await run(request("/channel/context"))).json()) as {
      referencePosts: Array<{ caption: string; hashtags: string[] }>;
    };

    expect(body.referencePosts[0].caption).toBe("Fifteen cents a day");
    expect(body.referencePosts[0].hashtags).toEqual(["claudecode", "buildinpublic"]);
  });

  it("uses the permalink shortcode as the post id", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [post("DbqRhj-p19Q", "x", 1_750_000_000_000)]);
    const body = (await (await run(request("/channel/context"))).json()) as {
      referencePosts: Array<{ id: string }>;
    };
    expect(body.referencePosts[0].id).toBe("DbqRhj-p19Q");
  });

  it("carries app-facing metrics, links and thumbnails in reference posts", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [
      post("rich", "numbers #proof", 1_750_000_000_000),
    ]);
    await withFullStats("rich");

    const body = (await (await run(request("/channel/context"))).json()) as {
      referencePosts: Array<{
        permalink: string | null;
        thumbnailURL: string | null;
        mediaURL: string | null;
        mediaType: string | null;
        likes: number | null;
        comments: number | null;
        reach: number | null;
        watch: number | null;
        views: number | null;
        skipRate: number | null;
        saves: number | null;
        shares: number | null;
      }>;
    };

    expect(body.referencePosts[0]).toMatchObject({
      permalink: "https://www.instagram.com/reel/rich/",
      thumbnailURL: "https://cdn.test/rich-stats.jpg",
      mediaURL: "https://cdn.test/rich-stats.jpg",
      mediaType: "VIDEO",
      likes: 24,
      comments: 3,
      reach: 321,
      watch: 5.6,
      views: 1234,
      skipRate: 0.42,
      saves: 9,
      shares: 4,
    });
  });

  it("keeps a tag out of the findings until enough posts carry it", async () => {
    // On an account where one post goes 20×, every tag it carried would come
    // back looking like a strategy. Two posts is still an anecdote.
    await db.saveAccountMedia(env.DB, IG_USER_ID, [
      post("a", "one #rare", 3),
      post("b", "two #rare", 2),
      post("c", "three #common", 1),
      post("d", "four #common", 4),
      post("e", "five #common", 5),
    ]);
    for (const [id, views] of [["a", 100], ["b", 100], ["c", 100], ["d", 100], ["e", 100]] as const) {
      await withStats(id, views);
    }

    const body = (await (await run(request("/channel/context"))).json()) as {
      hashtagFindings: Array<{ tag: string; postCount: number }>;
    };

    expect(body.hashtagFindings.map((f) => f.tag)).toEqual(["common"]);
    expect(body.hashtagFindings[0].postCount).toBe(3);
  });

  it("reports lift against the channel median", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [
      post("a", "a #winner", 5),
      post("b", "b #winner", 4),
      post("c", "c #winner", 3),
      post("d", "d plain", 2),
      post("e", "e plain", 1),
    ]);
    // Winners at 200, plain at 100 → channel median 200, winner median 200.
    for (const [id, views] of [["a", 200], ["b", 200], ["c", 200], ["d", 100], ["e", 100]] as const) {
      await withStats(id, views);
    }

    const body = (await (await run(request("/channel/context"))).json()) as {
      medianViews: number;
      hashtagFindings: Array<{ tag: string; lift: number }>;
    };

    expect(body.medianViews).toBe(200);
    expect(body.hashtagFindings[0].lift).toBe(1);
  });

  it("serves a pack with no posts rather than failing", async () => {
    // A brand-new install, or an account whose stats sweep has not run. The app
    // treats an evidence-free pack as "no context" and writes generic copy.
    const body = (await (await run(request("/channel/context"))).json()) as {
      referencePosts: unknown[];
      hashtagFindings: unknown[];
      medianViews: number | null;
    };

    expect(body.referencePosts).toEqual([]);
    expect(body.hashtagFindings).toEqual([]);
    expect(body.medianViews).toBeNull();
  });

  it("lists the connected accounts for the app picker", async () => {
    const body = (await (await run(request("/channel/accounts"))).json()) as Array<{
      igUserId: string;
      username: string;
    }>;

    expect(body).toEqual([
      { igUserId: IG_USER_ID, username: "cash.builds" },
      { igUserId: SECOND_ACCOUNT, username: "second.brands" },
    ]);
  });

  it("defaults to the first account and never blends accounts", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [post("mine", "mine caption", 2_000)]);
    await db.saveAccountMedia(env.DB, SECOND_ACCOUNT, [post("theirs", "theirs caption", 1_000)]);

    const body = (await (await run(request("/channel/context"))).json()) as {
      igUserId: string;
      handle: string;
      referencePosts: Array<{ id: string }>;
    };

    expect(body.igUserId).toBe(IG_USER_ID);
    expect(body.handle).toBe("cash.builds");
    expect(body.referencePosts.map((p) => p.id)).toEqual(["mine"]);
  });

  it("serves a per-account pack when asked for one", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [post("mine", "mine caption", 2_000)]);
    await db.saveAccountMedia(env.DB, SECOND_ACCOUNT, [post("theirs", "theirs caption", 1_000)]);
    await withStats("theirs", 500);

    const body = (await (
      await run(request(`/channel/context?account=${SECOND_ACCOUNT}`))
    ).json()) as {
      igUserId: string;
      handle: string;
      referencePosts: Array<{ id: string; views: number | null }>;
    };

    expect(body.igUserId).toBe(SECOND_ACCOUNT);
    expect(body.handle).toBe("second.brands");
    expect(body.referencePosts.map((p) => p.id)).toEqual(["theirs"]);
    expect(body.referencePosts[0].views).toBe(500);
  });

  it("serves an empty pack when no account is connected", async () => {
    await env.DB.prepare(`DELETE FROM accounts`).run();

    const body = (await (await run(request("/channel/context"))).json()) as {
      igUserId: string | null;
      referencePosts: unknown[];
    };

    expect(body.igUserId).toBeNull();
    expect(body.referencePosts).toEqual([]);
  });

  it("round-trips the uploaded brand and folds it into the pack", async () => {
    const brand = {
      handle: "cash.builds",
      positioning: "Build the paid tool for free, on camera.",
      voice: ["Say the number."],
      avoid: ["Never open with 'In this video'."],
      formats: [{ name: "walkie-talkie", definition: "Unscripted walk-and-talk, single take." }],
      postFormats: { a: "walkie-talkie", b: "walkie-talkie" },
    };

    const put = await run(
      request("/channel/brand", { method: "PUT", body: JSON.stringify(brand) }),
    );
    expect(put.status).toBe(200);

    await db.saveAccountMedia(env.DB, IG_USER_ID, [
      post("a", "one", 2),
      post("b", "two", 1),
    ]);
    await withStats("a", 300);
    await withStats("b", 100);

    const body = (await (await run(request("/channel/context"))).json()) as {
      handle: string;
      positioning: string;
      voice: string[];
      avoid: string[];
      formats: Array<{ name: string; postCount: number; medianViews: number }>;
      referencePosts: Array<{ format: string | null }>;
    };

    expect(body.handle).toBe("cash.builds");
    expect(body.positioning).toBe(brand.positioning);
    expect(body.voice).toEqual(brand.voice);
    expect(body.avoid).toEqual(brand.avoid);
    expect(body.formats[0]).toMatchObject({ name: "walkie-talkie", postCount: 2, medianViews: 200 });
    // The format labels are what let the app say "this is a walkie-talkie and
    // they run above median" instead of just listing captions.
    expect(body.referencePosts.every((p) => p.format === "walkie-talkie")).toBe(true);
  });

  it("keeps one account's brand out of another account's pack", async () => {
    const brand = {
      handle: "second.brands",
      igUserId: SECOND_ACCOUNT,
      positioning: "The second account's voice.",
      voice: ["Say the price."],
      avoid: [],
      formats: [],
      postFormats: {},
    };

    const put = await run(
      request("/channel/brand", { method: "PUT", body: JSON.stringify(brand) }),
    );
    expect(put.status).toBe(200);

    const forSecond = (await (
      await run(request(`/channel/context?account=${SECOND_ACCOUNT}`))
    ).json()) as { positioning: string; voice: string[] };
    expect(forSecond.positioning).toBe("The second account's voice.");
    expect(forSecond.voice).toEqual(["Say the price."]);

    const forFirst = (await (
      await run(request(`/channel/context?account=${IG_USER_ID}`))
    ).json()) as { positioning: string; voice: string[] };
    expect(forFirst.positioning).toBe("");
    expect(forFirst.voice).toEqual([]);
  });

  it("refuses a brand upload with no handle", async () => {
    const res = await run(
      request("/channel/brand", { method: "PUT", body: JSON.stringify({ positioning: "x" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses a publish over plain http", async () => {
    // Meta fetches the file itself and rejects a non-https URL with a message
    // that names neither the URL nor the scheme.
    const res = await run(
      request("/channel/publish", {
        method: "POST",
        body: JSON.stringify({ videoUrl: "http://example.test/reel.mp4", caption: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses a publish with no video", async () => {
    const res = await run(
      request("/channel/publish", { method: "POST", body: JSON.stringify({ caption: "x" }) }),
    );
    expect(res.status).toBe(400);
  });
});
