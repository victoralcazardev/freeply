import { describe, expect, it } from "vitest";
import { isCrawler } from "../../src/index";
import {
  UA_FACEBOOK_IOS,
  UA_FACEBOOK_PREVIEW,
  UA_INSTAGRAM_ANDROID,
  UA_INSTAGRAM_IOS,
  UA_MOBILE_SAFARI,
} from "../fixtures";

describe("isCrawler", () => {
  /**
   * The regression this file exists for. A previous version matched a bare
   * "instagram", which is in the user-agent of Instagram's in-app *browser* as
   * well as its fetchers — so every click from inside the app was thrown away,
   * silently, and that is where nearly all clicks on a DM link come from.
   */
  it("does not match Instagram's in-app browser", () => {
    expect(isCrawler(UA_INSTAGRAM_ANDROID)).toBe(false);
    expect(isCrawler(UA_INSTAGRAM_IOS)).toBe(false);
    expect(UA_INSTAGRAM_ANDROID.toLowerCase()).toContain("instagram");
    expect(UA_INSTAGRAM_IOS.toLowerCase()).toContain("instagram");
  });

  it("does not match other in-app browsers or ordinary ones", () => {
    expect(isCrawler(UA_FACEBOOK_IOS)).toBe(false);
    expect(isCrawler(UA_MOBILE_SAFARI)).toBe(false);
    expect(
      isCrawler(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
  });

  it("matches the automated fetchers", () => {
    expect(isCrawler(UA_FACEBOOK_PREVIEW)).toBe(true);
    expect(isCrawler("facebookcatalog/1.0")).toBe(true);
    expect(isCrawler("meta-externalagent/1.1")).toBe(true);
    expect(isCrawler("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isCrawler("Twitterbot/1.0")).toBe(true);
    expect(isCrawler("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")).toBe(true);
    expect(isCrawler("Mozilla/5.0 (compatible; Yahoo! Slurp)")).toBe(true);
    expect(isCrawler("HeadlessChrome/126.0.0.0")).toBe(true);
    expect(isCrawler("Mozilla/5.0 (compatible; SemrushBot/7~bl)")).toBe(true);
  });

  it("treats a missing user-agent as automated", () => {
    expect(isCrawler("")).toBe(true);
  });

  // "bot" needs a word boundary, or any UA containing those three letters mid-word
  // gets discarded.
  it("does not match 'bot' inside a longer word", () => {
    expect(isCrawler("Mozilla/5.0 Abbott/1.0")).toBe(false);
  });
});
