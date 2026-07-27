import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../../src/db";

const TARGET = "https://example.com/free-guide";

let id: string;

beforeEach(async () => {
  id = db.newId();
  await db.saveLink(env.DB, {
    id,
    code: db.newLinkCode(),
    targetUrl: TARGET,
    tracked: false,
  });
});

describe("untracked links", () => {
  it("stores the choice", async () => {
    const row = await env.DB.prepare("SELECT tracked FROM links WHERE id = ?")
      .bind(id)
      .first<{ tracked: number }>();
    expect(row?.tracked).toBe(0);
  });

  /**
   * D1 returns the column as the integer 0 or 1, and every caller compares it
   * against a boolean — `wrapped` in handleComment, the radio buttons in
   * campaignForm, `untracked` in linksTab. While the read path handed the
   * integer straight back, `0 === false` was false everywhere it mattered: "send
   * the URL as-is" was stored, then ignored by the DM, and editing the campaign
   * silently switched it back on.
   */
  it("reads back as the boolean its callers compare against", async () => {
    const link = await db.getLink(env.DB, id);
    expect(link?.tracked).toBe(false);
  });

  it("reads back as a boolean in the dashboard listing too", async () => {
    const listed = (await db.listLinks(env.DB)).find((l) => l.id === id);
    expect(listed?.tracked).toBe(false);
  });

  it("reads a tracked link back as true, not the integer", async () => {
    const trackedId = db.newId();
    await db.saveLink(env.DB, { id: trackedId, code: db.newLinkCode(), targetUrl: TARGET });

    expect((await db.getLink(env.DB, trackedId))?.tracked).toBe(true);
    expect((await db.listLinks(env.DB)).find((l) => l.id === trackedId)?.tracked).toBe(true);
  });

  it("still defaults to tracked when the choice is omitted", async () => {
    const trackedId = db.newId();
    await db.saveLink(env.DB, { id: trackedId, code: db.newLinkCode(), targetUrl: TARGET });

    const row = await env.DB.prepare("SELECT tracked FROM links WHERE id = ?")
      .bind(trackedId)
      .first<{ tracked: number }>();
    expect(row?.tracked).toBe(1);
  });
});
