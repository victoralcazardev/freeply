import { describe, expect, it } from "vitest";
import { esc } from "../../src/dashboard";

/**
 * The one escaper every page goes through.
 *
 * Message and draft text reaches the HTML from Instagram and from the CLI, so
 * this is the last place before a quote, a bracket or an ampersand can become
 * markup. The apostrophe is the one that matters here: the mobile page writes
 * attribute values for confirmations, and a name like "O'Neill" must survive
 * them without closing the attribute's counterpart.
 */
describe("esc", () => {
  it("escapes the four characters that end an attribute or open markup", () => {
    expect(esc(`<b>"x" & 'y'</b>`)).toBe("&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
  });

  it("keeps the apostrophe out of single-quoted attribute values", () => {
    // The page has `onsubmit="return confirm('...')"` in its markup, and any
    // lead text that reaches an attribute must not be able to close it.
    expect(esc("O'Neill")).toBe("O&#39;Neill");
    expect(esc("O'Neill")).not.toContain("'");
  });

  it("survives what a draft actually contains: newlines, emoji and a null", () => {
    expect(esc("Hola,\n¿qué tal? 👋")).toBe("Hola,\n¿qué tal? 👋");
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});
