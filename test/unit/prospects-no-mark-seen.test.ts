import { describe, expect, it } from "vitest";
import accountDoSource from "../../src/account-do.ts?raw";
import indexSource from "../../src/index.ts?raw";
import prospectsSource from "../../src/prospects.ts?raw";
import prospectsSendSource from "../../src/prospects-send.ts?raw";

/**
 * S11: reading a lead's conversation must not mark it seen. Instagram stops
 * notifying the operator for a thread once it is marked read, and the design
 * never trades that for an unread badge.
 *
 * A source check is the honest test here: the rule is the absence of a call,
 * not an observable difference in a payload we might otherwise assert on.
 */
describe("prospect webhook and sends", () => {
  it("never calls mark_seen or any sender action", () => {
    for (const source of [
      indexSource,
      prospectsSource,
      prospectsSendSource,
      accountDoSource,
    ]) {
      expect(source).not.toContain("mark_seen");
      expect(source).not.toContain("sender_action");
    }
  });
});
