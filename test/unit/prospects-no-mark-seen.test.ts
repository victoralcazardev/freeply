import { describe, expect, it } from "vitest";
import indexSource from "../../src/index.ts?raw";
import prospectsSource from "../../src/prospects.ts?raw";

/**
 * S11: reading a lead's conversation must not mark it seen. Instagram stops
 * notifying the operator for a thread once it is marked read, and the design
 * never trades that for an unread badge.
 *
 * A source check is the honest test here: the rule is the absence of a call,
 * not an observable difference in a payload we might otherwise assert on.
 */
describe("prospect webhook", () => {
  it("never calls mark_seen", () => {
    expect(indexSource).not.toContain("mark_seen");
    expect(prospectsSource).not.toContain("mark_seen");
  });
});
