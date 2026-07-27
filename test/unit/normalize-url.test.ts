import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../../src/db";

describe("normalizeUrl", () => {
  it("adds https:// to a bare domain, which is what people paste", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
    expect(normalizeUrl("example.com/pricing")).toBe("https://example.com/pricing");
    expect(normalizeUrl("sub.example.co.uk/a/b?q=1")).toBe("https://sub.example.co.uk/a/b?q=1");
  });

  it("leaves an existing scheme alone rather than forcing https", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(normalizeUrl("HTTPS://Example.com/Path")).toBe("https://example.com/Path");
  });

  it("trims whitespace, including the newline a copy-paste drags in", () => {
    expect(normalizeUrl("  example.com  ")).toBe("https://example.com/");
    expect(normalizeUrl("\n example.com/x \t")).toBe("https://example.com/x");
  });

  it("returns null for junk instead of storing an unreachable target", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
    // Parses, but has no dot — "https://hello" goes nowhere.
    expect(normalizeUrl("hello")).toBeNull();
    expect(normalizeUrl("localhost")).toBeNull();
  });

  // The normalized value ends up in an href on the escape page, so a scheme that
  // isn't http(s) must not survive.
  it("rejects non-http schemes", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("ftp://example.com/x")).toBeNull();
    expect(normalizeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });
});
