import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * The dashboard renders from D1 and talks to Instagram afterwards.
 *
 * It used to await both refreshes before emitting a byte, so a stale cache put
 * the page behind a round trip to Meta and a dead token put it behind a failing
 * one. These tests pin the ordering rather than the timing: a response that
 * exists before any Graph call has been made cannot have waited on one, and
 * that holds on a fast machine and a slow one alike.
 */

/** Graph calls recorded in order, and whether the response had been built yet. */
let graphCalls: Array<{ path: string; afterResponse: boolean }> = [];
let responded = false;

function stubMeta() {
  graphCalls = [];
  responded = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      graphCalls.push({ path: url.pathname, afterResponse: responded });
      return new Response(
        JSON.stringify({ data: [], id: "x" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

/** A Graph endpoint that never answers — the dead-token case, exaggerated. */
function stubHangingMeta() {
  graphCalls = [];
  responded = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      graphCalls.push({ path: url.pathname, afterResponse: responded });
      // Resolves only when the caller's own timeout fires. A fetch with no
      // signal would hang here forever, which is exactly the bug.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }),
  );
}

beforeEach(async () => {
  for (const table of ["post_stats", "account_media", "settings", "sends", "accounts"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "an_account",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
  // One cached post with no stats at all, so the refresh path has work to do.
  await db.saveAccountMedia(env.DB, IG_USER_ID, [
    {
      mediaId: "post-1",
      caption: "a post",
      thumbnailUrl: null,
      permalink: null,
      mediaType: "VIDEO",
      postedAt: 1_000,
    },
  ]);
});

afterEach(() => vi.unstubAllGlobals());

/**
 * Loads the overview and hands back the response *and* the context, unsettled.
 *
 * The settling is the caller's business: the point of every test here is what
 * is true at the moment the response exists, and awaiting `waitUntil` first
 * would wait out the very background work being measured.
 */
async function loadOverview(): Promise<{ response: Response; ctx: ExecutionContext }> {
  const cookie = sessionCookie(await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD));
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://freeply.test/", { headers: { cookie: cookie.split(";")[0] } }),
    env,
    ctx,
  );
  responded = true;
  return { response, ctx };
}

describe("dashboard render", () => {
  it("answers before it has asked Instagram anything", async () => {
    stubMeta();
    const { response, ctx } = await loadOverview();

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Post performance");

    await waitOnExecutionContext(ctx);
    // The refresh still happens — it just happens behind the response.
    expect(graphCalls.length).toBeGreaterThan(0);
    expect(graphCalls.every((c) => c.afterResponse)).toBe(true);
  });

  it(
    "renders, and gives up on Instagram, when Instagram never answers",
    async () => {
      stubHangingMeta();
      const { response, ctx } = await loadOverview();

      // Before the fix this could not return at all: the render awaited a fetch
      // that had no timeout on it, so a silent Graph endpoint was an infinite
      // page load rather than a page with stale numbers.
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Post performance");

      // And the background work does not hang forever either — it unwinds when
      // GRAPH_TIMEOUT_MS fires, which is what this await is waiting out. Slow on
      // purpose: a passing assertion here is the timeout doing its job.
      await waitOnExecutionContext(ctx);
      expect(graphCalls.every((c) => c.afterResponse)).toBe(true);
    },
    20_000,
  );
});
