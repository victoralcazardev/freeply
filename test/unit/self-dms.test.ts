import { describe, expect, it } from "vitest";
import { extractSelfDMs } from "../../src/index";

/** The connected account — the only one this worker holds a token for. */
const CONNECTED = "17841400000000001";
/** The operator's other account. It has no token here and never fires a webhook. */
const OTHER_SELF = "17841400000000002";
const STRANGER = "3000000000000009";

const SELF = new Set([CONNECTED, OTHER_SELF]);

function delivery(messaging: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [{ id: CONNECTED, time: 1786000000000, messaging: [messaging] }],
  };
}

/** other → connected: an ordinary inbound message. */
function inbound(message: Record<string, unknown> = {}, from = OTHER_SELF) {
  return delivery({
    sender: { id: from },
    recipient: { id: CONNECTED },
    timestamp: 1786000000000,
    message: { mid: "mid-inbound", text: "this hook is unreal", ...message },
  });
}

/** connected → other: seen only as an echo of our own send. */
function echo(to = OTHER_SELF) {
  return delivery({
    sender: { id: CONNECTED },
    recipient: { id: to },
    timestamp: 1786000000000,
    is_echo: true,
    message: { mid: "mid-echo", text: "save this one" },
  });
}

describe("extractSelfDMs", () => {
  it("keeps a message from the operator's other account", () => {
    const [idea] = extractSelfDMs(inbound(), SELF);
    expect(idea.messageId).toBe("mid-inbound");
    expect(idea.senderId).toBe(OTHER_SELF);
    expect(idea.isEcho).toBe(false);
    expect(idea.text).toBe("this hook is unreal");
  });

  /**
   * The case every other handler in the codebase deliberately drops. Only one of
   * the two accounts is connected, so an idea sent FROM it exists nowhere else —
   * skipping echoes here would lose that whole direction silently.
   */
  it("keeps an echo addressed to the operator's other account", () => {
    const [idea] = extractSelfDMs(echo(), SELF);
    expect(idea.messageId).toBe("mid-echo");
    expect(idea.isEcho).toBe(true);
    expect(idea.recipientId).toBe(OTHER_SELF);
  });

  it("drops a stranger's DM", () => {
    expect(extractSelfDMs(inbound({}, STRANGER), SELF)).toEqual([]);
  });

  /** An echo of a DM freeply sent a lead is a campaign send, not an idea. */
  it("drops an echo addressed to a stranger", () => {
    expect(extractSelfDMs(echo(STRANGER), SELF)).toEqual([]);
  });

  it("stores nothing when no self ids are configured", () => {
    expect(extractSelfDMs(inbound(), new Set())).toEqual([]);
  });

  it("pulls the link out of a shared reel", () => {
    const [idea] = extractSelfDMs(
      inbound({
        text: undefined,
        attachments: [
          {
            type: "ig_reel",
            payload: { url: "https://lookaside.fbsbx.com/ig_messaging/x", reel_video_id: "17900000000000001" },
          },
        ],
      }),
      SELF,
    );
    expect(idea.attachmentType).toBe("ig_reel");
    expect(idea.sharedUrl).toBe("https://lookaside.fbsbx.com/ig_messaging/x");
    expect(idea.sharedMediaId).toBe("17900000000000001");
    expect(idea.text).toBe("");
  });

  /**
   * The parse above is a guess against fields Meta does not document. The raw
   * event is what makes a wrong guess recoverable, so assert it survives whole.
   */
  it("keeps the whole event verbatim even when nothing parses", () => {
    const [idea] = extractSelfDMs(
      inbound({ attachments: [{ type: "something_new", payload: { unexpected: "shape" } }] }),
      SELF,
    );
    expect(idea.attachmentType).toBe("something_new");
    expect(idea.sharedUrl).toBeNull();
    expect(JSON.parse(idea.raw).message.attachments[0].payload.unexpected).toBe("shape");
  });

  it("ignores a comment delivery, which uses changes rather than messaging", () => {
    const comments = {
      object: "instagram",
      entry: [{ id: CONNECTED, changes: [{ field: "comments", value: { id: "1", text: "hi" } }] }],
    };
    expect(extractSelfDMs(comments, SELF)).toEqual([]);
  });
});
