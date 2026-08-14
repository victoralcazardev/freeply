import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import worker from "../../src/index";
import { FIXTURE_SECRETS } from "../fixtures";

/**
 * /files serves the workspace's reels out of R2.
 *
 * The test that matters is Range. iOS Safari opens a video with
 * `Range: bytes=0-1` and refuses to play at all if the answer is a 200 with the
 * whole body — not a stall, a flat refusal — and scrubbing is the same mechanism.
 * So a 206 with a correct Content-Range is the difference between this feature
 * working on the phone and not existing, and it gets asserted byte for byte.
 */

const KEY = "renders/2026-08-02-demo/reel.mp4";
// 26 bytes, so an offset is legible in a failure message.
const BODY = "abcdefghijklmnopqrstuvwxyz";

async function seed() {
  const existing = await env.MEDIA!.list({ limit: 1000 });
  for (const o of existing.objects) await env.MEDIA!.delete(o.key);
  await env.MEDIA!.put(KEY, BODY);
  await env.MEDIA!.put(`${KEY}.jpg`, "poster-bytes");
}

/** Via bytes: .text() on a video/mp4 body makes workerd warn about corruption. */
async function body(res: Response): Promise<string> {
  return new TextDecoder().decode(await res.arrayBuffer());
}

async function get(path: string, headers: Record<string, string> = {}, signedIn = true) {
  const cookie = signedIn
    ? { cookie: sessionCookie(await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD)).split(";")[0] }
    : {};
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://freeply.test${path}`, { headers: { ...cookie, ...headers } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(seed);

describe("the session gate", () => {
  it("covers /files and /files/<key>, carrying the destination", async () => {
    for (const path of ["/files", `/files/${KEY}`]) {
      const res = await get(path, {}, false);
      expect({ path, status: res.status, to: res.headers.get("location") }).toEqual({
        path,
        status: 302,
        to: `/login?next=${encodeURIComponent(path)}`,
      });
    }
  });
});

/**
 * Reels served before /files switched to no-store went out with
 * `private, max-age=3600`, and a stored response is replayed without the cookie
 * being consulted — so clearing the session cookie does nothing to them and they
 * stay reachable from the back button for the rest of that hour. Clearing the
 * cache at sign-out is what evicts them.
 */
describe("signing out", () => {
  it("tells the browser to drop what it cached for this origin", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://freeply.test/logout", { method: "POST" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
    // Not "storage": the workspace page keeps its board seed and chat history in
    // localStorage, and signing out is not a request to delete those.
    expect(res.headers.get("clear-site-data")).not.toContain("storage");
  });
});

describe("GET /files/<key> ranges", () => {
  it("answers iOS's opening probe with 206 and a correct Content-Range", async () => {
    const res = await get(`/files/${KEY}`, { range: "bytes=0-1" });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-1/${BODY.length}`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await body(res)).toBe("ab");
  });

  it("serves a mid-file range, which is what scrubbing asks for", async () => {
    const res = await get(`/files/${KEY}`, { range: "bytes=10-14" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-14/${BODY.length}`);
    expect(await body(res)).toBe("klmno");
  });

  it("serves an open-ended range to the end of the object", async () => {
    const res = await get(`/files/${KEY}`, { range: "bytes=20-" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 20-25/${BODY.length}`);
    expect(await body(res)).toBe("uvwxyz");
  });

  it("resolves a suffix range against the real size", async () => {
    const res = await get(`/files/${KEY}`, { range: "bytes=-4" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 22-25/${BODY.length}`);
    expect(await body(res)).toBe("wxyz");
  });

  it("serves the whole object, and advertises ranges, when none is asked for", async () => {
    const res = await get(`/files/${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-range")).toBe(null);
    // Authenticated media, so nothing may keep a copy that outlives the session.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toBe(BODY);
  });
});

describe("GET /files/<key> caching", () => {
  it("returns 304 for a matching If-None-Match", async () => {
    const first = await get(`/files/${KEY}`);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"/);

    const second = await get(`/files/${KEY}`, { "if-none-match": etag });
    expect(second.status).toBe(304);
    expect(await body(second)).toBe("");
  });

  it("still serves the body when the etag has moved on", async () => {
    const res = await get(`/files/${KEY}`, { "if-none-match": '"not-the-etag"' });
    expect(res.status).toBe(200);
    expect(await body(res)).toBe(BODY);
  });
});

describe("GET /files/<key> misses", () => {
  it("404s an unknown key rather than falling through to the dashboard", async () => {
    const res = await get("/files/renders/nope.mp4");
    expect(res.status).toBe(404);
  });
});

describe("GET /files", () => {
  it("lists the object under its folder and hides the poster as a row", async () => {
    const html = await (await get("/files")).text();

    expect(html).toContain("renders/2026-08-02-demo");
    expect(html).toContain("reel.mp4</a>");
    // The poster is a thumbnail, not an entry of its own.
    expect(html).not.toContain("reel.mp4.jpg</a>");
    expect(html).toContain(`poster="/files/${KEY}.jpg"`);
    expect(html).toContain('preload="none"');
    // Part A's lesson: no page ships without one.
    expect(html).toContain('name="viewport"');
  });

  it("says how to publish when the bucket is empty", async () => {
    const listed = await env.MEDIA!.list({ limit: 1000 });
    for (const o of listed.objects) await env.MEDIA!.delete(o.key);

    const html = await (await get("/files")).text();
    expect(html).toContain("publish-media.sh");
  });
});
