import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * The MCP endpoint is the one door that hands data to something outside the
 * operator's browser, so the auth cases matter more than the happy path: a
 * wrong token, a missing token, and the dashboard password must all bounce.
 */

const call = async (body: unknown, opts: { token?: string; path?: string } = {}) => {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const response = await worker.fetch(
    new Request(`https://freeply.test${opts.path ?? "/mcp"}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
};

const rpc = (method: string, params: unknown = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM account_media`).run();
  await env.DB.prepare(`DELETE FROM post_stats`).run();
});

describe("/mcp", () => {
  it("rejects a missing or wrong token, and the dashboard password", async () => {
    expect((await call(rpc("tools/list"))).status).toBe(401);
    expect((await call(rpc("tools/list"), { token: "wrong" })).status).toBe(401);
    expect(
      (await call(rpc("tools/list"), { token: FIXTURE_SECRETS.DASHBOARD_PASSWORD })).status,
    ).toBe(401);
  });

  it("accepts the token in the path — how a claude.ai connector calls it", async () => {
    const response = await call(rpc("tools/list"), {
      path: `/mcp/${FIXTURE_SECRETS.MCP_STATS_TOKEN}`,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["get_post_stats", "refresh_stats"]);
  });

  /**
   * A redirect here reads as "this server has a sign-in service", which sends
   * an MCP client down dynamic client registration instead of just calling the
   * capability URL — claude.ai failed to add the connector for exactly this.
   */
  it("404s OAuth discovery probes instead of redirecting to login", async () => {
    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/register",
    ]) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`https://freeply.test${p}`), env, ctx);
      await waitOnExecutionContext(ctx);
      expect({ path: p, status: response.status }).toEqual({ path: p, status: 404 });
    }
  });

  it("initializes with tools capability", async () => {
    const response = await call(rpc("initialize", { protocolVersion: "2025-06-18" }), {
      token: FIXTURE_SECRETS.MCP_STATS_TOKEN,
    });
    const body = (await response.json()) as {
      result: {
        protocolVersion: string;
        capabilities: { tools?: Record<string, unknown> };
        serverInfo: { name: string };
      };
    };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("freeply-stats");
    // Without an advertised tools capability a client never calls tools/list,
    // so the whole endpoint reads as empty however well the tools work.
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("serves post stats from the cache, newest first", async () => {
    await db.saveAccountMedia(env.DB, IG_USER_ID, [
      {
        mediaId: "m-old",
        caption: "older",
        thumbnailUrl: null,
        permalink: "https://instagram.com/p/old",
        mediaType: "VIDEO",
        postedAt: 1_000,
      },
      {
        mediaId: "m-new",
        caption: "newer",
        thumbnailUrl: null,
        permalink: "https://instagram.com/p/new",
        mediaType: "VIDEO",
        postedAt: 2_000,
      },
    ]);

    // The report LEFT JOINs post_stats, so seeding media alone leaves every
    // metric null — the join could be broken and the caption order would still
    // pass. Persist real numbers so the stats half is actually asserted.
    await db.savePostStats(env.DB, "m-new", {
      reach: 900,
      likes: 42,
      comments: 7,
      saved: 12,
      shares: 3,
      views: 5_000,
      skipRate: 48.5,
      avgWatchMs: 4_200,
      permalink: "https://instagram.com/p/new",
      caption: "newer",
      thumbnailUrl: null,
      mediaType: "VIDEO",
    });

    const response = await call(rpc("tools/call", { name: "get_post_stats", arguments: {} }), {
      token: FIXTURE_SECRETS.MCP_STATS_TOKEN,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const rows = JSON.parse(body.result.content[0].text) as Array<{
      caption: string;
      views: number | null;
      likes: number | null;
    }>;
    expect(rows.map((r) => r.caption)).toEqual(["newer", "older"]);
    expect(rows[0].views).toBe(5_000);
    expect(rows[0].likes).toBe(42);
    // The post with no stats row still appears, with the metrics nulled.
    expect(rows[1].views).toBeNull();
  });
});
