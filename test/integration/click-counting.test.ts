import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../../src/db";
import worker from "../../src/index";
import {
  UA_FACEBOOK_PREVIEW,
  UA_INSTAGRAM_ANDROID,
  UA_INSTAGRAM_IOS,
  UA_MOBILE_SAFARI,
} from "../fixtures";

const TARGET = "https://example.com/free-guide";

let code: string;

beforeEach(async () => {
  code = db.newLinkCode();
  await db.saveLink(env.DB, { id: db.newId(), code, targetUrl: TARGET });
});

async function visit(path: string, headers: Record<string, string>): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://freeply.test${path}`, { headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function clicks(): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT clicks FROM links WHERE code = ?")
    .bind(code)
    .first<{ clicks: number }>();
  return row?.clicks;
}

describe("GET /l/:code click counting", () => {
  it("counts a real navigation and redirects to the target", async () => {
    const response = await visit(`/l/${code}`, {
      "user-agent": UA_MOBILE_SAFARI,
      "sec-fetch-mode": "navigate",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(await clicks()).toBe(1);
  });

  /**
   * Instagram fetches a link the moment a DM containing it is *displayed*. Those
   * fetches outnumber real clicks, and counting them turns the only conversion
   * number in the dashboard into noise.
   */
  it("does not count a link preview fetch", async () => {
    const response = await visit(`/l/${code}`, { "user-agent": UA_FACEBOOK_PREVIEW });

    expect(response.status).toBe(302);
    expect(await clicks()).toBe(0);
  });

  it("does not count a fetch that isn't a navigation", async () => {
    await visit(`/l/${code}`, {
      "user-agent": UA_MOBILE_SAFARI,
      "sec-fetch-mode": "no-cors",
    });
    await visit(`/l/${code}`, { "user-agent": "" });

    expect(await clicks()).toBe(0);
  });

  /**
   * Android in-app gets the handoff page instead of a redirect, so the visit
   * itself must not count — the page's beacon does it, once. Counting both would
   * double every Android click; counting neither is the bug that shipped.
   */
  it("counts an Android in-app visit exactly once, via the escape page beacon", async () => {
    const handoff = await visit(`/l/${code}`, {
      "user-agent": UA_INSTAGRAM_ANDROID,
      "sec-fetch-mode": "navigate",
    });

    expect(handoff.status).toBe(200);
    expect(handoff.headers.get("content-type")).toContain("text/html");
    expect(await handoff.text()).toContain(TARGET);
    expect(await clicks()).toBe(0);

    // What navigator.sendBeacon sends from that page.
    const beacon = await visit(`/l/${code}?counted=1`, {
      "user-agent": UA_INSTAGRAM_ANDROID,
      "sec-fetch-mode": "no-cors",
    });

    expect(beacon.status).toBe(204);
    expect(await clicks()).toBe(1);
  });

  /**
   * iOS in-app gets no interstitial — every programmatic escape is blocked there,
   * so the hop costs a visible pause and buys nothing. It goes straight through,
   * and it counts here rather than via a beacon.
   */
  it("counts an iOS in-app visit on the redirect itself", async () => {
    const response = await visit(`/l/${code}`, {
      "user-agent": UA_INSTAGRAM_IOS,
      "sec-fetch-mode": "navigate",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(await clicks()).toBe(1);
  });

  it("404s an unknown code", async () => {
    const response = await visit("/l/notacode", {
      "user-agent": UA_MOBILE_SAFARI,
      "sec-fetch-mode": "navigate",
    });
    expect(response.status).toBe(404);
  });
});
