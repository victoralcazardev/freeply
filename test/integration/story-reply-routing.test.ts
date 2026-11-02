import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../../src/db";
import { handleStoryReply } from "../../src/index";
import { IG_USER_ID } from "../fixtures";

const SENDER = "3001881596673527";
const STORY = "17948132847250967";

const reply = (over: Partial<Parameters<typeof handleStoryReply>[0]> = {}) => ({
  igUserId: IG_USER_ID,
  messageId: "mid_1",
  senderId: SENDER,
  storyId: STORY,
  text: "Hell ya",
  ...over,
});

async function campaign(over: Partial<db.Campaign> = {}) {
  const id = db.newId();
  await db.saveCampaign(env.DB, {
    id,
    igUserId: IG_USER_ID,
    name: "story campaign",
    mediaId: null,
    keywords: ["hell"],
    matchMode: "whole_word",
    dedupeScope: "per_post",
    storyReplies: true,
    iceBreaker: null,
    dmMessage: "Here you go",
    publicReply: "check your DMs",
    linkId: null,
    active: true,
    ...over,
  });
  return id;
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM campaigns`).run();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "cash.builds",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
});

describe("handleStoryReply routing", () => {
  /** The account replying to its own story, and the echo of our own answer. */
  it("skips a reply from the connected account", async () => {
    await campaign();
    expect(await handleStoryReply(reply({ senderId: IG_USER_ID }), env, "freeply.test")).toBe(
      "self",
    );
  });

  /**
   * Off by default, and staying off is the whole point of the column — turning
   * it on is a decision about who gets messaged.
   */
  it("ignores a campaign that hasn't opted into story replies", async () => {
    await campaign({ storyReplies: false });
    expect(await handleStoryReply(reply(), env, "freeply.test")).toBe("no-match");
  });

  /**
   * A campaign pinned to a post is asking about that post. A story isn't it, and
   * answering would send that post's link to someone who never saw it.
   */
  it("ignores a campaign pinned to a post, even with story replies on", async () => {
    await campaign({ mediaId: "17900000000000001" });
    expect(await handleStoryReply(reply(), env, "freeply.test")).toBe("no-match");
  });

  it("still requires the keyword to match", async () => {
    await campaign();
    expect(await handleStoryReply(reply({ text: "nice one" }), env, "freeply.test")).toBe(
      "no-match",
    );
  });

  /** whole_word "hell" is the live configuration; "hello" must not fire it. */
  it("does not fire on hello", async () => {
    await campaign();
    expect(await handleStoryReply(reply({ text: "hello!" }), env, "freeply.test")).toBe(
      "no-match",
    );
  });

  it("matches regardless of case, the way a comment would", async () => {
    await campaign();
    // Gets past matching, so it reaches the send rather than returning no-match.
    expect(await handleStoryReply(reply({ text: "HELL YA" }), env, "freeply.test")).not.toBe(
      "no-match",
    );
  });
});

describe("handleStoryReply message shape", () => {
  let bodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    bodies = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ message_id: "mid_sent" }), { status: 200 });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  /**
   * Instagram doesn't always make a bare URL in a DM tappable, so the link goes
   * on a button. Still the tracked link, so the click is still counted.
   */
  it("puts the link on a button rather than in the text", async () => {
    const linkId = db.newId();
    await db.saveLink(env.DB, { id: linkId, code: "abc1234", targetUrl: "https://example.com/r" });
    await campaign({ linkId });

    expect(await handleStoryReply(reply(), env, "freeply.test")).toBe("sent");
    expect(bodies[0].message).toEqual({
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Here you go",
          buttons: [{ type: "web_url", url: "https://freeply.test/l/abc1234", title: "Abrir enlace" }],
        },
      },
    });
  });

  it("sends plain text when the campaign has no link", async () => {
    await campaign();

    expect(await handleStoryReply(reply(), env, "freeply.test")).toBe("sent");
    expect(bodies[0].message).toEqual({ text: "Here you go" });
  });

  /** The template caps text at 640 characters; past that Meta refuses the send. */
  it("falls back to the link in the text when it's too long for a button", async () => {
    const linkId = db.newId();
    await db.saveLink(env.DB, { id: linkId, code: "long123", targetUrl: "https://example.com/r" });
    const long = "x".repeat(641);
    await campaign({ linkId, dmMessage: long });

    expect(await handleStoryReply(reply(), env, "freeply.test")).toBe("sent");
    expect(bodies[0].message).toEqual({ text: `${long}\n\nhttps://freeply.test/l/long123` });
  });
});
