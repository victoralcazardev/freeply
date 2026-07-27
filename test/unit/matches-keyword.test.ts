import { describe, expect, it } from "vitest";
import { matchesKeyword } from "../../src/index";

describe("matchesKeyword", () => {
  it("defaults to whole word, so a keyword inside a longer word doesn't fire", () => {
    expect(matchesKeyword("send me the link", ["link"])).toBe(true);
    expect(matchesKeyword("I've been linking to this all week", ["link"])).toBe(false);
    expect(matchesKeyword("great backlink", ["link"])).toBe(false);
  });

  it("matches anywhere in the text in contains mode", () => {
    expect(matchesKeyword("I've been linking to this all week", ["link"], "contains")).toBe(true);
    expect(matchesKeyword("great backlink", ["link"], "contains")).toBe(true);
    expect(matchesKeyword("nothing relevant here", ["link"], "contains")).toBe(false);
  });

  // People shout. A campaign keyed on "link" that ignores "LINKKK" looks broken
  // to the one person most likely to convert, which is why contains mode exists.
  it("LINKKK: whole word misses it, contains catches it", () => {
    expect(matchesKeyword("LINKKK", ["link"], "whole_word")).toBe(false);
    expect(matchesKeyword("LINKKK", ["link"], "contains")).toBe(true);
    expect(matchesKeyword("LINKKK please 🙏", ["link"], "contains")).toBe(true);
  });

  it("ignores case in both modes — nobody types the keyword the way it was set", () => {
    expect(matchesKeyword("LINK", ["link"])).toBe(true);
    expect(matchesKeyword("Link please", ["link"])).toBe(true);
    expect(matchesKeyword("link", ["LINK"])).toBe(true);
    expect(matchesKeyword("BACKLINK", ["link"], "contains")).toBe(true);
  });

  it("treats punctuation and emoji as word boundaries", () => {
    expect(matchesKeyword("LINK!", ["link"])).toBe(true);
    expect(matchesKeyword("#link", ["link"])).toBe(true);
    expect(matchesKeyword("...link...", ["link"])).toBe(true);
    expect(matchesKeyword("(link)", ["link"])).toBe(true);
    expect(matchesKeyword("link?", ["link"])).toBe(true);
    expect(matchesKeyword("hey @me, link 👀", ["link"])).toBe(true);
    expect(matchesKeyword("link\nplease", ["link"])).toBe(true);
    // Underscore is a word character, so this stays a single word.
    expect(matchesKeyword("link_in_bio", ["link"])).toBe(false);
  });

  it("matches a multi-word keyword as typed", () => {
    expect(matchesKeyword("please send me", ["send me"])).toBe(true);
    expect(matchesKeyword("please send  me", ["send me"])).toBe(false);
  });

  // Keywords are free text from the campaign form. Unescaped, "a+b" or "." would
  // be a regex and match things the operator never asked for.
  it("escapes regex metacharacters in the keyword", () => {
    expect(matchesKeyword("I want a+b", ["a+b"], "contains")).toBe(true);
    expect(matchesKeyword("aaab", ["a+b"], "contains")).toBe(false);
    expect(matchesKeyword("send x.y", ["x.y"])).toBe(true);
    expect(matchesKeyword("send xzy", ["x.y"])).toBe(false);
    expect(matchesKeyword("what (now)", ["(now)"])).toBe(true);
  });

  it("matches a keyword sitting at the very start or end of a comment", () => {
    expect(matchesKeyword("link", ["link"])).toBe(true);
    expect(matchesKeyword("link please", ["link"])).toBe(true);
    expect(matchesKeyword("please link", ["link"])).toBe(true);
  });

  it("fires on any keyword in the list, and on none when none of them appear", () => {
    const keywords = ["link", "guide", "send me"];
    expect(matchesKeyword("guide please", keywords)).toBe(true);
    expect(matchesKeyword("send me that", keywords)).toBe(true);
    expect(matchesKeyword("LINK 🙌", keywords)).toBe(true);
    expect(matchesKeyword("lovely photo", keywords)).toBe(false);
  });

  it("applies the mode to every keyword, not only the first", () => {
    expect(matchesKeyword("guideeee", ["link", "guide"], "whole_word")).toBe(false);
    expect(matchesKeyword("guideeee", ["link", "guide"], "contains")).toBe(true);
  });

  /**
   * An empty pattern in contains mode matches every comment ever posted, so one
   * stray comma in the campaign form would otherwise DM the whole audience.
   */
  it("never matches on a blank keyword", () => {
    expect(matchesKeyword("lovely photo", [""], "contains")).toBe(false);
    expect(matchesKeyword("lovely photo", ["  "], "contains")).toBe(false);
    expect(matchesKeyword("lovely photo", ["", "link"], "contains")).toBe(false);
    expect(matchesKeyword("lovely photo", [])).toBe(false);
  });
});
