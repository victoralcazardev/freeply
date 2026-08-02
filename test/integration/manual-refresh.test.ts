import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * POST /refresh is the manual override for the hourly sweep: it must ignore
 * every freshness stamp, and it must sit behind the session like any other
 * dashboard action — it spends Graph API budget, so drive-by requests don't
 * get to trigger it.
 */

let graphCalls: string[] = [];

function stubMeta() {
  graphCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      graphCalls.push(url.pathname);
      return new Response(
        JSON.stringify({
          data: url.pathname.endsWith("/me/media")
            ? [{ id: "fresh-post", media_type: "VIDEO", timestamp: new Date(5_000).toISOString() }]
            : [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM account_media`).run();
  await env.DB.prepare(`DELETE FROM settings`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "an_account",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
});

afterEach(() => vi.unstubAllGlobals());

const refreshRequest = (headers: Record<string, string> = {}) =>
  new Request("https://freeply.test/refresh", { method: "POST", headers });

describe("POST /refresh", () => {
  it("redirects to login without a session, touching nothing", async () => {
    stubMeta();
    const ctx = createExecutionContext();
    const response = await worker.fetch(refreshRequest(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
    expect(graphCalls).toEqual([]);
  });

  it("sweeps despite a fresh cache, and lands back on the overview", async () => {
    // Stamp the media cache as just-read: the TTL path would do nothing here,
    // which is exactly what a manual refresh exists to override.
    await db.saveAccountMedia(env.DB, IG_USER_ID, []);
    stubMeta();

    const cookie = sessionCookie(await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD));
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      refreshRequest({ cookie: cookie.split(";")[0] }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(graphCalls.some((p) => p.endsWith("/me/media"))).toBe(true);
    expect((await db.listAccountMedia(env.DB, IG_USER_ID)).map((m) => m.mediaId)).toEqual([
      "fresh-post",
    ]);
  });
});

/**
 * Opening /workspace cold used to sign you in and then drop you on Freeply's
 * own dashboard — "why is it taking me to Freeply". The destination has to
 * survive the sign-in, without turning /login into an open redirect.
 */
describe("sign-in destination", () => {
  it("carries the intended path into /login", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://freeply.test/workspace"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fworkspace");
  });

  it("returns to that path after a correct password", async () => {
    const ctx = createExecutionContext();
    const body = new URLSearchParams({
      password: FIXTURE_SECRETS.DASHBOARD_PASSWORD,
      next: "/workspace",
    });
    const res = await worker.fetch(
      new Request("https://freeply.test/login", { method: "POST", body }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("location")).toBe("/workspace");
  });

  it("refuses an off-site next", async () => {
    for (const bad of ["//evil.example", "https://evil.example"]) {
      const ctx = createExecutionContext();
      const body = new URLSearchParams({
        password: FIXTURE_SECRETS.DASHBOARD_PASSWORD,
        next: bad,
      });
      const res = await worker.fetch(
        new Request("https://freeply.test/login", { method: "POST", body }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect({ bad, to: res.headers.get("location") }).toEqual({ bad, to: "/" });
    }
  });
});
