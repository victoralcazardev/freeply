import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../../src/db";
import worker, { storeSelfDMs } from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * Ideas the operator DMs themselves between two accounts. The thing under test
 * is mostly what gets REFUSED — the table exists to hold their own messages, and
 * a bug that widened it would quietly start keeping other people's.
 */

const OTHER_SELF = "17841400000000002";
const STRANGER = "3000000000000009";

function delivery(messaging: Record<string, unknown>) {
  return { object: "instagram", entry: [{ id: IG_USER_ID, messaging: [messaging] }] };
}

const inbound = (from: string, mid = "mid-1", message: Record<string, unknown> = {}) =>
  delivery({
    sender: { id: from },
    recipient: { id: IG_USER_ID },
    message: { mid, text: "steal this hook", ...message },
  });

const mcp = async (name: string, args: Record<string, unknown> = {}) => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://freeply.test/mcp/${FIXTURE_SECRETS.MCP_STATS_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const body = (await response.json()) as { result?: { content: Array<{ text: string }> } };
  return body.result?.content[0]?.text ?? "";
};

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM dm_inbox`).run();
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('dm_self_ids', ?, 0)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(`${IG_USER_ID},${OTHER_SELF}`)
    .run();
});

describe("dm_inbox capture", () => {
  it("stores a DM from the operator's other account", async () => {
    await storeSelfDMs(inbound(OTHER_SELF), env);

    const [idea] = await db.listDMIdeas(env.DB);
    expect(idea.senderId).toBe(OTHER_SELF);
    expect(idea.text).toBe("steal this hook");
    expect(idea.processedAt).toBeNull();
  });

  it("stores nothing for a stranger's DM", async () => {
    await storeSelfDMs(inbound(STRANGER), env);
    expect(await db.listDMIdeas(env.DB)).toEqual([]);
  });

  /**
   * The feature ships off. An install that never configures its ids must not
   * accumulate messages, so the empty seed has to mean "store nothing" rather
   * than "match everything".
   */
  it("stores nothing when no self ids are configured", async () => {
    await env.DB.prepare(`UPDATE settings SET value = '' WHERE key = 'dm_self_ids'`).run();
    await storeSelfDMs(inbound(OTHER_SELF), env);
    expect(await db.listDMIdeas(env.DB)).toEqual([]);
  });

  /**
   * Meta retries any delivery it doesn't get a prompt 200 for. Two rows for one
   * idea would show up as a duplicate card in the queue.
   */
  it("keeps one row when Meta redelivers the same message", async () => {
    await storeSelfDMs(inbound(OTHER_SELF), env);
    await storeSelfDMs(inbound(OTHER_SELF), env);
    expect(await db.listDMIdeas(env.DB)).toHaveLength(1);
  });

  it("captures the outbound direction, which arrives only as an echo", async () => {
    await storeSelfDMs(
      delivery({
        sender: { id: IG_USER_ID },
        recipient: { id: OTHER_SELF },
        is_echo: true,
        message: { mid: "mid-echo", text: "this format works" },
      }),
      env,
    );

    const [idea] = await db.listDMIdeas(env.DB);
    expect(idea.isEcho).toBe(true);
    expect(idea.text).toBe("this format works");
  });

  it("keeps the raw event when the attachment shape is unrecognised", async () => {
    await storeSelfDMs(
      inbound(OTHER_SELF, "mid-share", {
        attachments: [{ type: "ig_reel", payload: { url: "https://lookaside.fbsbx.com/z" } }],
      }),
      env,
    );

    const row = await env.DB.prepare(`SELECT raw_json FROM dm_inbox WHERE mid = 'mid-share'`).first<{
      raw_json: string;
    }>();
    expect(JSON.parse(row?.raw_json ?? "{}").message.attachments[0].payload.url).toBe(
      "https://lookaside.fbsbx.com/z",
    );
  });
});

describe("dm_inbox MCP tools", () => {
  it("lists captured ideas and hides them once processed", async () => {
    await storeSelfDMs(inbound(OTHER_SELF, "mid-a"), env);

    expect(await mcp("list_dm_ideas")).toContain("mid-a");
    expect(await mcp("mark_dm_idea_processed", { mid: "mid-a" })).toContain("marked");

    expect(await mcp("list_dm_ideas")).not.toContain("mid-a");
    // Marking hides it from the default read; it must not delete the record.
    expect(await mcp("list_dm_ideas", { openOnly: false })).toContain("mid-a");
  });

  it("reports an unknown id rather than claiming it marked one", async () => {
    expect(await mcp("mark_dm_idea_processed", { mid: "nope" })).toContain("already processed");
  });
});
