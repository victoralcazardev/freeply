import { describe, expect, it } from "vitest";
import { dashboardPage } from "../../src/dashboard";
import type { Account, Campaign, MediaItem } from "../../src/db";
import { IG_USER_ID } from "../fixtures";

const ACCOUNT: Account = {
  igUserId: IG_USER_ID,
  username: "an_account",
  tokenExpiresAt: Date.now() + 60 * 86_400_000,
  connectedAt: 0,
  needsReconnect: false,
  reconnectReason: null,
};

const POST_ID = "17900000000000001";

const POST: MediaItem = {
  mediaId: POST_ID,
  igUserId: IG_USER_ID,
  caption: "The giveaway post",
  thumbnailUrl: "https://cdn.test/thumb.jpg",
  permalink: "https://instagram.com/p/abc",
  mediaType: "IMAGE",
  postedAt: Date.UTC(2026, 5, 1),
};

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

function campaignsTab(over: { media?: MediaItem[]; editing?: Campaign | null }): Promise<string> {
  return dashboardPage({
    accounts: [ACCOUNT],
    campaigns: over.editing ? [over.editing] : [],
    links: [],
    sends: [],
    stats: { sent: 0, failed: 0, duplicate: 0 },
    posts: [],
    media: over.media ?? [],
    host: "freeply.test",
    tab: "campaigns",
    editing: over.editing ?? null,
    filter: {},
  }).text();
}

describe("campaign form — post picker", () => {
  it("offers each cached post, with its thumbnail and caption", async () => {
    const html = await campaignsTab({ media: [POST] });

    expect(html).toContain(`type="radio" name="media_id" value="${POST_ID}"`);
    expect(html).toContain("The giveaway post");
    expect(html).toContain("https://cdn.test/thumb.jpg");
    // Any post stays the default, and a raw ID stays reachable.
    expect(html).toContain(`type="radio" name="media_id" value="" checked`);
    expect(html).toContain(`name="media_id_manual"`);
  });

  // An account whose media can't be read still has to be able to run a campaign.
  it("falls back to the raw ID field when nothing is cached", async () => {
    const html = await campaignsTab({ media: [] });

    expect(html).toContain(`<input id="media" name="media_id"`);
    expect(html).not.toContain(`type="radio" name="media_id"`);
  });

  it("preselects the post an edited campaign is pinned to", async () => {
    const html = await campaignsTab({
      media: [POST],
      editing: campaign({ mediaId: POST_ID }),
    });

    expect(html).toContain(`type="radio" name="media_id" value="${POST_ID}" checked`);
    expect(html).toContain(`name="media_id_manual" value=""`);
  });

  // A post older than the cached window, or one typed in by hand, has to survive
  // an edit rather than being silently reset to "any post".
  it("keeps a pinned post that isn't in the list, on the manual option", async () => {
    const html = await campaignsTab({
      media: [POST],
      editing: campaign({ mediaId: "17900000000000999" }),
    });

    expect(html).toContain(`type="radio" name="media_id" value="manual" checked`);
    expect(html).toContain(`name="media_id_manual" value="17900000000000999"`);
    expect(html).not.toContain(`value="" checked`);
  });
});

describe("campaign form — keywords", () => {
  it("shows the stored list the way the field expects it back", async () => {
    const html = await campaignsTab({ editing: campaign({ keywords: ["link", "send me"] }) });

    expect(html).toContain(`name="keywords" required value="link, send me"`);
  });
});
