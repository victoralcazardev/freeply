import { describe, expect, it } from "vitest";
import { shadowedIds } from "../../src/dashboard";
import type { Campaign } from "../../src/db";
import { IG_USER_ID } from "../fixtures";

/** Campaigns arrive newest-first, the order listCampaigns returns them in. */
function campaign(over: Partial<Campaign> & { id: string }): Campaign {
  return {
    igUserId: IG_USER_ID,
    name: over.id,
    mediaId: null,
    keywords: ["link"],
    matchMode: "whole_word",
    dedupeScope: "per_post",
    storyReplies: false,
    iceBreaker: null,
    dmMessage: "here you go",
    publicReply: null,
    linkId: null,
    active: true,
    createdAt: 0,
    ...over,
  };
}

const ids = (cs: Campaign[]) => [...shadowedIds(cs)].sort();

describe("shadowedIds", () => {
  it("shadows the older of two campaigns on the same account, keyword and scope", () => {
    expect(ids([campaign({ id: "new" }), campaign({ id: "old" })])).toEqual(["old"]);
  });

  it("leaves different keywords alone", () => {
    const cs = [
      campaign({ id: "a", keywords: ["link"] }),
      campaign({ id: "b", keywords: ["guide"] }),
    ];
    expect(ids(cs)).toEqual([]);
  });

  it("leaves the same keyword on a different account alone", () => {
    const cs = [campaign({ id: "a" }), campaign({ id: "b", igUserId: "17841400000000002" })];
    expect(ids(cs)).toEqual([]);
  });

  // Documented behaviour, and the reason scope is part of the key: the specific
  // campaign wins on its own post, the account-wide one covers everything else.
  it("does not shadow an account-wide campaign with a post-specific one", () => {
    const cs = [campaign({ id: "post", mediaId: "1789" }), campaign({ id: "all", mediaId: null })];
    expect(ids(cs)).toEqual([]);
  });

  it("shadows two post-specific campaigns on the same post and keyword", () => {
    const cs = [
      campaign({ id: "new", mediaId: "1789" }),
      campaign({ id: "old", mediaId: "1789" }),
    ];
    expect(ids(cs)).toEqual(["old"]);
  });

  it("leaves post-specific campaigns on different posts alone", () => {
    const cs = [
      campaign({ id: "a", mediaId: "1789" }),
      campaign({ id: "b", mediaId: "1790" }),
    ];
    expect(ids(cs)).toEqual([]);
  });

  // A paused campaign can't fire and can't block one, so it neither shadows nor
  // gets flagged — otherwise the dashboard would nag about deliberate pauses.
  it("ignores inactive campaigns in both directions", () => {
    const cs = [
      campaign({ id: "paused", active: false }),
      campaign({ id: "live" }),
      campaign({ id: "also-paused", active: false }),
    ];
    expect(ids(cs)).toEqual([]);
  });

  // Matching is case-insensitive, so "LINK" and "link" really are the same
  // campaign twice — flagging only exact string matches would miss it.
  it("compares keywords case-insensitively", () => {
    const cs = [
      campaign({ id: "new", keywords: ["LINK"] }),
      campaign({ id: "old", keywords: ["link"] }),
    ];
    expect(ids(cs)).toEqual(["old"]);
  });

  /**
   * A whole-word campaign doesn't cover a contains one: activeCampaignsFor
   * returns both and handleComment takes the first that matches, so on "LINKKK"
   * the strict one misses and the loose one fires. Flagging it would tell the
   * operator to delete a campaign that is doing all the work.
   */
  it("does not shadow a broader-matching campaign", () => {
    const cs = [
      campaign({ id: "strict", matchMode: "whole_word" }),
      campaign({ id: "loose", matchMode: "contains" }),
    ];
    expect(ids(cs)).toEqual([]);
  });

  // The other direction does hold: contains matches everything whole word does.
  it("shadows a stricter campaign under a broader one", () => {
    const cs = [
      campaign({ id: "loose", matchMode: "contains" }),
      campaign({ id: "strict", matchMode: "whole_word" }),
    ];
    expect(ids(cs)).toEqual(["strict"]);
  });

  it("leaves a campaign alive while any one of its keywords is still free", () => {
    const cs = [
      campaign({ id: "new", keywords: ["link"] }),
      campaign({ id: "old", keywords: ["link", "guide"] }),
    ];
    expect(ids(cs)).toEqual([]);
  });

  it("shadows a campaign whose every keyword is already taken", () => {
    const cs = [
      campaign({ id: "new", keywords: ["link", "guide"] }),
      campaign({ id: "old", keywords: ["guide", "link"] }),
    ];
    expect(ids(cs)).toEqual(["old"]);
  });

  // Coverage can come from more than one campaign: neither newer one covers the
  // older on its own, but together they leave it nothing to match.
  it("shadows a campaign covered by two others between them", () => {
    const cs = [
      campaign({ id: "new-a", keywords: ["link"] }),
      campaign({ id: "new-b", keywords: ["guide"] }),
      campaign({ id: "old", keywords: ["link", "guide"] }),
    ];
    expect(ids(cs)).toEqual(["old"]);
  });
});
