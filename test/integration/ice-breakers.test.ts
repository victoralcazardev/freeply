import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../../src/db";
import { extractPostbacks, handlePostback } from "../../src/index";
import { ICE_BREAKER_PREFIX } from "../../src/instagram";
import { IG_USER_ID } from "../fixtures";

const SENDER = "3001881596673527";

function delivery(payload: string, over: Record<string, unknown> = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_USER_ID,
        time: 1784979653664,
        messaging: [
          {
            sender: { id: SENDER },
            recipient: { id: IG_USER_ID },
            timestamp: 1784979652995,
            postback: { mid: "mid_tap_1", title: "Send me the guide", payload },
            ...over,
          },
        ],
      },
    ],
  };
}

async function campaign(over: Partial<db.Campaign> = {}) {
  const id = db.newId();
  await db.saveCampaign(env.DB, {
    id,
    igUserId: IG_USER_ID,
    name: "welcome",
    mediaId: null,
    keywords: ["never-matches"],
    matchMode: "whole_word",
    dedupeScope: "per_post",
    storyReplies: false,
    iceBreaker: "Send me the guide",
    dmMessage: "Here you go",
    publicReply: null,
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

describe("extractPostbacks", () => {
  it("reads a tap carrying our payload", () => {
    expect(extractPostbacks(delivery(`${ICE_BREAKER_PREFIX}cmp_1`))).toEqual([
      {
        igUserId: IG_USER_ID,
        messageId: "mid_tap_1",
        senderId: SENDER,
        campaignId: "cmp_1",
        title: "Send me the guide",
      },
    ]);
  });

  /** Someone else's automation, or a Meta-generated postback. Not ours to answer. */
  it("ignores a postback that isn't ours", () => {
    expect(extractPostbacks(delivery("SOME_OTHER_TOOL:42"))).toEqual([]);
  });

  it("ignores our prefix with no campaign after it", () => {
    expect(extractPostbacks(delivery(ICE_BREAKER_PREFIX))).toEqual([]);
  });

  it("ignores a story reply, which carries no postback", () => {
    const storyReply = {
      object: "instagram",
      entry: [
        {
          id: IG_USER_ID,
          messaging: [
            {
              sender: { id: SENDER },
              message: { mid: "m1", text: "hi", reply_to: { story: { id: "s1" } } },
            },
          ],
        },
      ],
    };
    expect(extractPostbacks(storyReply)).toEqual([]);
  });
});

describe("handlePostback routing", () => {
  const tap = (campaignId: string, over: Record<string, unknown> = {}) => ({
    igUserId: IG_USER_ID,
    messageId: "mid_tap_1",
    senderId: SENDER,
    campaignId,
    title: "Send me the guide",
    ...over,
  });

  /**
   * Meta keeps showing a published question until the next publish, so a tap can
   * outlive the campaign that put it there.
   */
  it("ignores a tap for a campaign that no longer exists", async () => {
    expect(await handlePostback(tap("gone"), env, "freeply.test")).toBe("no-campaign");
  });

  it("ignores a tap for a paused campaign", async () => {
    const id = await campaign({ active: false });
    expect(await handlePostback(tap(id), env, "freeply.test")).toBe("no-campaign");
  });

  /** The payload is attacker-supplied in principle; it must not reach across accounts. */
  it("refuses a campaign belonging to another account", async () => {
    const id = await campaign();
    expect(await handlePostback(tap(id, { igUserId: "17800000000000000" }), env, "freeply.test")).toBe(
      "no-campaign",
    );
  });

  it("skips a tap that appears to come from the account itself", async () => {
    const id = await campaign();
    expect(await handlePostback(tap(id, { senderId: IG_USER_ID }), env, "freeply.test")).toBe(
      "self",
    );
  });

  /**
   * Routing is by payload, not keyword — they tapped a specific question, and
   * that tap is the intent. This campaign's keyword matches nothing on purpose.
   */
  it("answers on the payload alone, with no keyword involved", async () => {
    const id = await campaign();
    expect(await handlePostback(tap(id), env, "freeply.test")).not.toBe("no-campaign");
  });
});
