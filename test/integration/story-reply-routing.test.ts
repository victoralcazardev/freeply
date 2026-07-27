import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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
