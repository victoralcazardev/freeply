import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { IG_USER_ID } from "../fixtures";

/**
 * One Durable Object per test, named like the account it stands for. Real
 * instances are keyed by IG user ID, which is what makes the dedupe per-account.
 */
function account(suffix: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(`${IG_USER_ID}-${suffix}`));
}

const CAMPAIGN = "cmp_free_guide";
const COMMENTER = "78901234567890123";

describe("AccountDO dedupe", () => {
  /**
   * The sequence that matters. Meta redelivered the same comment three seconds
   * apart in production; a private reply is one-shot per commenter, so the second
   * delivery must not spend it — but a failed send has to be retryable.
   */
  it("claims, rejects the duplicate, then allows a retry after release", async () => {
    const acc = account("sequence");

    expect(await acc.claim(CAMPAIGN, COMMENTER)).toBe(true);
    expect(await acc.claim(CAMPAIGN, COMMENTER)).toBe(false);
    expect(await acc.count()).toBe(1);

    await acc.release(CAMPAIGN, COMMENTER);
    expect(await acc.count()).toBe(0);

    expect(await acc.claim(CAMPAIGN, COMMENTER)).toBe(true);
    expect(await acc.claim(CAMPAIGN, COMMENTER)).toBe(false);
  });

  it("rejects every redelivery, not just the second", async () => {
    const acc = account("redeliveries");
    const results = [
      await acc.claim(CAMPAIGN, COMMENTER),
      await acc.claim(CAMPAIGN, COMMENTER),
      await acc.claim(CAMPAIGN, COMMENTER),
      await acc.claim(CAMPAIGN, COMMENTER),
    ];
    expect(results).toEqual([true, false, false, false]);
    expect(await acc.count()).toBe(1);
  });

  it("keys on campaign and commenter together, so neither blocks the other", async () => {
    const acc = account("keys");

    expect(await acc.claim(CAMPAIGN, COMMENTER)).toBe(true);
    // Same person, a different campaign — a separate message they haven't had.
    expect(await acc.claim("cmp_webinar", COMMENTER)).toBe(true);
    // Same campaign, a different person.
    expect(await acc.claim(CAMPAIGN, "11111111111111111")).toBe(true);
    expect(await acc.count()).toBe(3);
  });

  it("releases only the claim it is given", async () => {
    const acc = account("release-scope");

    await acc.claim(CAMPAIGN, COMMENTER);
    await acc.claim(CAMPAIGN, "11111111111111111");

    await acc.release(CAMPAIGN, COMMENTER);
    expect(await acc.claim(CAMPAIGN, COMMENTER)).toBe(true);
    expect(await acc.claim(CAMPAIGN, "11111111111111111")).toBe(false);
  });

  it("ignores a release for something never claimed", async () => {
    const acc = account("release-unknown");
    await acc.release(CAMPAIGN, COMMENTER);
    expect(await acc.count()).toBe(0);
  });

  /**
   * What the per-post key buys, at the level the DO actually sees it: two posts
   * under one account-wide campaign are two claims, not a duplicate.
   */
  it("treats per-post keys from one campaign as separate claims", async () => {
    const acc = account("per-post");

    expect(await acc.claim(`${CAMPAIGN}#17900000000000001`, COMMENTER)).toBe(true);
    expect(await acc.claim(`${CAMPAIGN}#17900000000000002`, COMMENTER)).toBe(true);
    // Still one message per post — a redelivery on either is refused.
    expect(await acc.claim(`${CAMPAIGN}#17900000000000001`, COMMENTER)).toBe(false);
    expect(await acc.count()).toBe(2);
  });

  /**
   * Why SendJob carries dedupeKey separately from campaignId. A release that
   * used the campaign id against a per-post claim would free nothing, and the
   * commenter would stay blocked until the prune — a failed send that can never
   * be retried, which is exactly what release() exists to prevent.
   */
  it("does not free a per-post claim when released under the campaign id", async () => {
    const acc = account("wrong-key-release");
    const key = `${CAMPAIGN}#17900000000000001`;

    await acc.claim(key, COMMENTER);
    await acc.release(CAMPAIGN, COMMENTER);

    expect(await acc.claim(key, COMMENTER)).toBe(false);
    await acc.release(key, COMMENTER);
    expect(await acc.claim(key, COMMENTER)).toBe(true);
  });

  it("keeps accounts apart", async () => {
    expect(await account("account-a").claim(CAMPAIGN, COMMENTER)).toBe(true);
    expect(await account("account-b").claim(CAMPAIGN, COMMENTER)).toBe(true);
  });

  it("clear() forgets every claim and reports how many it dropped", async () => {
    const acc = account("clear");

    await acc.claim(CAMPAIGN, COMMENTER);
    await acc.claim(CAMPAIGN, "11111111111111111");

    expect(await acc.clear()).toBe(2);
    expect(await acc.count()).toBe(0);
    expect(await acc.claim(CAMPAIGN, COMMENTER)).toBe(true);
  });
});
