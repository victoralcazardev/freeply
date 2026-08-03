import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import worker from "../../src/index";
import { FIXTURE_SECRETS } from "../fixtures";

/**
 * /workspace-state is the shared copy of the cash.builds board. Before it existed
 * the board lived in `cbops-*` localStorage, so the laptop and the phone each kept
 * a private copy and silently disagreed the moment both got used.
 *
 * What has to hold: it sits behind the session like every other board endpoint, a
 * write is readable by the *next* request (that is the whole feature), the section
 * name is an allowlist, and the updatedAt stamp moves forward — the page's
 * reconcile loop uses it to decide whether the server's copy beats its own.
 */

const url = "https://cashbuilds.test/workspace-state";
const authed = async () =>
  sessionCookie(await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD)).split(";")[0];

async function call(init: RequestInit & { cookie?: string } = {}) {
  const { cookie, ...rest } = init;
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(url, {
      ...rest,
      headers: { ...(rest.headers ?? {}), ...(cookie ? { cookie } : {}) },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const post = (body: unknown, cookie: string) =>
  call({
    method: "POST",
    cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM workspace_state`).run();
});

describe("/workspace-state", () => {
  it("redirects to login without a session", async () => {
    expect((await call()).status).toBe(302);
    expect((await post({ section: "queue", value: { items: [] } }, "")).status).toBe(302);
  });

  it("round-trips a section — the write is visible to the next reader", async () => {
    const cookie = await authed();
    const board = { v: 19, items: [{ id: "queue-0", t: "RLS walk-and-talk", done: true }] };

    const wrote = await post({ section: "queue", value: board }, cookie);
    expect(wrote.status).toBe(200);
    const { updatedAt } = (await wrote.json()) as { updatedAt: number };
    expect(updatedAt).toBeGreaterThan(0);

    // A second device, same session, its own request: this is the bug being fixed.
    const read = (await call({ cookie })) as Response;
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ queue: { value: board, updatedAt } });
  });

  it("keeps sections independent — checking off a card can't clobber ideas", async () => {
    const cookie = await authed();
    await post({ section: "queue", value: { items: ["q"] } }, cookie);
    await post({ section: "ideas", value: { items: ["i"] } }, cookie);
    await post({ section: "queue", value: { items: ["q", "q2"] } }, cookie);

    const state = (await (await call({ cookie })).json()) as Record<string, { value: unknown }>;
    expect(state.queue.value).toEqual({ items: ["q", "q2"] });
    expect(state.ideas.value).toEqual({ items: ["i"] });
  });

  it("moves updatedAt forward on rewrite, so the other device knows to adopt it", async () => {
    const cookie = await authed();
    const first = (await (await post({ section: "miles", value: { n: 1 } }, cookie)).json()) as {
      updatedAt: number;
    };
    // Date.now() has ms resolution; without this the two stamps can tie and the
    // reconcile loop's `>=` would skip a real update.
    await new Promise((r) => setTimeout(r, 2));
    const second = (await (await post({ section: "miles", value: { n: 2 } }, cookie)).json()) as {
      updatedAt: number;
    };
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it("rejects an unknown section rather than growing a row for it", async () => {
    const cookie = await authed();
    expect((await post({ section: "../etc", value: {} }, cookie)).status).toBe(400);
    const { results } = await env.DB.prepare(`SELECT section FROM workspace_state`).all();
    expect(results).toEqual([]);
  });

  it("rejects a missing value and unparseable json", async () => {
    const cookie = await authed();
    expect((await post({ section: "queue" }, cookie)).status).toBe(400);
    expect(
      (
        await call({
          method: "POST",
          cookie,
          headers: { "content-type": "application/json" },
          body: "{not json",
        })
      ).status,
    ).toBe(400);
  });

  it("returns an empty object before anything is stored, so a fresh device seeds", async () => {
    expect(await (await call({ cookie: await authed() })).json()).toEqual({});
  });
});
