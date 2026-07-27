import { describe, expect, it } from "vitest";
import { splitKeywords } from "../../src/db";

describe("splitKeywords", () => {
  it("splits on commas, which is how the form asks for them", () => {
    expect(splitKeywords("link, guide, send me")).toEqual(["link", "guide", "send me"]);
  });

  // Pasting a list out of a note brings newlines with it.
  it("splits on newlines too, and trims what's left", () => {
    expect(splitKeywords("link\n  guide \n\nsend me")).toEqual(["link", "guide", "send me"]);
  });

  it("drops blanks, so a trailing comma isn't a keyword", () => {
    expect(splitKeywords("link,")).toEqual(["link"]);
    expect(splitKeywords(" , , ")).toEqual([]);
    expect(splitKeywords("")).toEqual([]);
  });

  // Matching ignores case, so the second one could never fire on its own and
  // only makes the campaign list look wrong.
  it("drops case-insensitive duplicates, keeping the first spelling", () => {
    expect(splitKeywords("LINK, link, Link, guide")).toEqual(["LINK", "guide"]);
  });

  it("keeps a keyword containing spaces intact", () => {
    expect(splitKeywords("send me the link")).toEqual(["send me the link"]);
  });
});
