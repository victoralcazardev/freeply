import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../../src/db";
import worker from "../../src/index";
import { IG_USER_ID } from "../fixtures";

const TOKEN = "test-api-token";
const apiEnv = { ...env, API_TOKEN: TOKEN };

async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string | null; env?: typeof env } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request(`https://freeply.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, opts.env ?? apiEnv, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json() };
}

const valid = {
  name: "GUIDE",
  ig_user_id: IG_USER_ID,
  media_id: null,
  keywords: ["guide", "Guía"],
  match_mode: "whole_word",
  dm_message: "Here: {link}",
};

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM campaigns`).run();
  await env.DB.prepare(`DELETE FROM links`).run();
  await env.DB.prepare(`DELETE FROM sends`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "an_account",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("auth", () => {
  it("answers 404 for every route when API_TOKEN is unset", async () => {
    const r = await call("GET", "/api/accounts", undefined, { env });
    expect(r.status).toBe(404);
    const empty = await call("GET", "/api/campaigns", undefined, { env: { ...env, API_TOKEN: "" } });
    expect(empty.status).toBe(404);
  });

  it("answers 401 for a missing or wrong token", async () => {
    expect((await call("GET", "/api/accounts", undefined, { token: null })).status).toBe(401);
    const wrong = await call("GET", "/api/accounts", undefined, { token: "nope" });
    expect(wrong).toEqual({ status: 401, json: { error: "unauthorized" } });
  });

  it("lists accounts", async () => {
    const r = await call("GET", "/api/accounts");
    expect(r.json.accounts).toEqual([
      { ig_user_id: IG_USER_ID, username: "an_account", needs_reconnect: false },
    ]);
  });
});

describe("campaigns", () => {
  it("round-trips create, patch, list and delete, minting and reusing links", async () => {
    const created = await call("POST", "/api/campaigns", {
      ...valid,
      link_url: "https://example.com/guide",
    });
    expect(created.status).toBe(201);
    const c = created.json.campaign;
    expect(c).toMatchObject({
      name: "GUIDE",
      media_id: null,
      keywords: ["guide", "Guía"],
      match_mode: "whole_word",
      dedupe_scope: "per_post",
      public_reply: null,
      link_url: "https://example.com/guide",
      track_link: true,
      active: true,
      stats: { sent: 0, failed: 0, duplicate: 0, recovered: 0 },
      clicks: 0,
    });

    // Same URL on patch reuses the link row; clicks and stats show up.
    const stored = await db.getCampaign(env.DB, c.id);
    const link = await db.getLink(env.DB, stored!.linkId!);
    await db.resolveLink(env.DB, link!.code, true);
    for (const status of ["sent", "recovered", "failed"]) {
      await db.recordSend(env.DB, {
        campaignId: c.id,
        igUserId: IG_USER_ID,
        commentId: `k-${status}`,
        commenterId: "1",
        status,
      });
    }

    const patched = await call("PATCH", `/api/campaigns/${c.id}`, {
      name: "GUIDE 2",
      active: false,
      link_url: "https://example.com/guide",
      track_link: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.campaign).toMatchObject({
      name: "GUIDE 2",
      active: false,
      track_link: false,
      clicks: 1,
      stats: { sent: 2, failed: 1, duplicate: 0, recovered: 1 },
    });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM links`).first<{ n: number }>())?.n).toBe(1);

    const listed = await call("GET", "/api/campaigns");
    expect(listed.json.campaigns).toHaveLength(1);
    expect(listed.json.campaigns[0].id).toBe(c.id);

    const removed = await call("PATCH", `/api/campaigns/${c.id}`, { link_url: null });
    expect(removed.json.campaign.link_url).toBeNull();
    expect((await db.getCampaign(env.DB, c.id))?.linkId).toBeNull();

    const replaced = await call("PATCH", `/api/campaigns/${c.id}`, { link_url: "https://example.com/new" });
    expect(replaced.json.campaign.link_url).toBe("https://example.com/new");
    expect(replaced.json.campaign.clicks).toBe(0);

    expect(await call("DELETE", `/api/campaigns/${c.id}`)).toEqual({
      status: 200,
      json: { deleted: c.id },
    });
    expect((await call("GET", "/api/campaigns")).json.campaigns).toEqual([]);
  });

  it("answers 404 for an unknown id", async () => {
    expect((await call("PATCH", "/api/campaigns/nope", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", "/api/campaigns/nope")).status).toBe(404);
  });

  it.each(["%", "%ZZ", "%E0%A4%A"])("answers JSON 404 for malformed id escape %s", async (id) => {
    for (const method of ["PATCH", "DELETE"]) {
      const r = await call(method, `/api/campaigns/${id}`, method === "PATCH" ? { name: "x" } : undefined);
      expect(r).toEqual({ status: 404, json: { error: "not_found" } });
    }
  });

  it.each([
    ["unknown account", { ig_user_id: "999" }, "ig_user_id"],
    ["empty keywords", { keywords: [] }, "keywords"],
    ["blank keywords", { keywords: ["  "] }, "keywords"],
    ["bad match_mode", { match_mode: "fuzzy" }, "match_mode"],
    ["bad dedupe_scope", { dedupe_scope: "global" }, "dedupe_scope"],
    ["empty dm", { dm_message: "  " }, "dm_message"],
    ["dm over 1000 bytes", { dm_message: "é".repeat(501) }, "dm_message"],
    ["public reply over 1000 bytes", { public_reply: "x".repeat(1001) }, "public_reply"],
    ["non-http link", { link_url: "ftp://example.com/x" }, "link_url"],
    ["bare-host link", { link_url: "example.com/x" }, "link_url"],
  ])("rejects %s", async (_label, patch, field) => {
    const r = await call("POST", "/api/campaigns", { ...valid, ...patch });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_field");
    expect(r.json.detail).toContain(field);
    expect((await call("GET", "/api/campaigns")).json.campaigns).toEqual([]);
  });

  it("accepts a dm of exactly 1000 bytes and requires the core fields", async () => {
    expect((await call("POST", "/api/campaigns", { ...valid, dm_message: "x".repeat(1000) })).status).toBe(201);
    const { name: _n, ...noName } = valid;
    expect((await call("POST", "/api/campaigns", noName)).json.detail).toContain("name");
  });
});

describe("graph reads", () => {
  const graph = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  let urls: string[];

  function stub(pages: Record<string, unknown>) {
    urls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        urls.push(u);
        const key = u.includes("page=2") ? "2" : u.includes("page=3") ? "3" : "1";
        return graph(pages[key]);
      }),
    );
  }

  const m = (id: string) => ({
    id,
    caption: "c".repeat(300),
    media_type: "IMAGE",
    permalink: `https://instagram.com/p/${id}`,
    timestamp: "2026-01-02T03:04:05+0000",
  });

  it("follows paging.next for media until the limit", async () => {
    stub({
      "1": { data: [m("a"), m("b")], paging: { next: "https://graph.instagram.com/next?page=2" } },
      "2": { data: [m("c"), m("d")], paging: { next: "https://graph.instagram.com/next?page=3" } },
      "3": { data: [m("e")] },
    });
    const r = await call("GET", `/api/media?ig_user_id=${IG_USER_ID}&limit=3`);
    expect(r.json.media.map((x: any) => x.media_id)).toEqual(["a", "b", "c"]);
    expect(urls).toHaveLength(2);
    expect(r.json.media[0]).toMatchObject({
      permalink: "https://instagram.com/p/a",
      media_type: "IMAGE",
      timestamp: "2026-01-02T03:04:05.000Z",
    });
    expect(r.json.media[0].caption).toHaveLength(200);

    const all = await call("GET", `/api/media?ig_user_id=${IG_USER_ID}`);
    expect(all.json.media).toHaveLength(5);
  });

  it("follows paging.next for comments", async () => {
    stub({
      "1": {
        data: [{ id: "1", text: "guide", timestamp: "2026-01-02T03:04:05+0000", username: "ann" }],
        paging: { next: "https://graph.instagram.com/next?page=2" },
      },
      "2": { data: [{ id: "2", text: "hi", from: { id: "9", username: "bob" } }] },
    });
    const r = await call("GET", `/api/comments?ig_user_id=${IG_USER_ID}&media_id=555&limit=10`);
    expect(r.json.comments).toEqual([
      { id: "1", text: "guide", timestamp: "2026-01-02T03:04:05.000Z", username: "ann" },
      { id: "2", text: "hi", timestamp: null, username: "bob" },
    ]);
    expect(urls[0]).toContain("/555/comments");
  });

  it("does not follow a next URL off Graph's host", async () => {
    stub({ "1": { data: [m("a")], paging: { next: "https://evil.test/?page=2" } } });
    const r = await call("GET", `/api/media?ig_user_id=${IG_USER_ID}`);
    expect(r.json.media).toHaveLength(1);
    expect(urls).toHaveLength(1);
  });

  it("validates account and limit", async () => {
    expect((await call("GET", "/api/media?ig_user_id=nope")).status).toBe(400);
    expect((await call("GET", `/api/media?ig_user_id=${IG_USER_ID}&limit=501`)).status).toBe(400);
    expect((await call("GET", `/api/comments?ig_user_id=${IG_USER_ID}`)).status).toBe(400);
  });
});
