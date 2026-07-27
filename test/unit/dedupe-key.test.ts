import { describe, expect, it } from "vitest";
import { type Campaign, dedupeKey } from "../../src/db";
import { IG_USER_ID } from "../fixtures";

const POST_A = "17900000000000001";
const POST_B = "17900000000000002";

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: "cmp",
    igUserId: IG_USER_ID,
    name: "Free guide",
    mediaId: null,
    keywords: ["link"],
    matchMode: "contains",
    dedupeScope: "per_post",
    storyReplies: false,
    iceBreaker: null,
    dmMessage: "Here it is: {link}",
    publicReply: null,
    linkId: null,
    active: true,
    createdAt: 0,
    ...over,
  };
}

describe("dedupeKey", () => {
  /**
   * The case this exists for. An account-wide campaign keyed on the campaign
   * alone answered the first post someone commented on and silently refused
   * every one after it, so the people who engaged most got the least.
   */
  it("gives an account-wide campaign a different key per post", () => {
    const c = campaign();
    expect(dedupeKey(c, POST_A)).not.toBe(dedupeKey(c, POST_B));
  });

  it("gives the same post the same key, so redeliveries still collide", () => {
    const c = campaign();
    expect(dedupeKey(c, POST_A)).toBe(dedupeKey(c, POST_A));
  });

  it("keys on the campaign alone when it is pinned to a post", () => {
    // The id already implies the post; adding it again would only make the key
    // longer, and would differ from a claim taken before the post was known.
    const c = campaign({ mediaId: POST_A });
    expect(dedupeKey(c, POST_A)).toBe("cmp");
  });

  it("keys on the campaign alone in 'campaign' scope, across posts", () => {
    const c = campaign({ dedupeScope: "campaign" });
    expect(dedupeKey(c, POST_A)).toBe("cmp");
    expect(dedupeKey(c, POST_B)).toBe("cmp");
  });

  /**
   * The webhook's media id is optional; reconciliation always supplies one. If a
   * missing id produced its own key, the same comment would claim differently
   * depending on which path found it and could be messaged twice — so an unknown
   * post falls back to the campaign, which refuses rather than duplicates.
   */
  it("falls back to the campaign when the post is unknown", () => {
    const c = campaign();
    expect(dedupeKey(c, undefined)).toBe("cmp");
    expect(dedupeKey(c, "")).toBe("cmp");
  });

  it("never collides across campaigns", () => {
    expect(dedupeKey(campaign({ id: "a" }), POST_A)).not.toBe(
      dedupeKey(campaign({ id: "b" }), POST_A),
    );
  });
});
