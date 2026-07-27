import { describe, expect, it } from "vitest";
import { extractStoryReplies } from "../../src/index";

const IG_ACCOUNT = "17841400000000001";
const SENDER = "3000000000000001";
const STORY = "17940000000000001";

/**
 * The shape Meta actually delivered on 25 July 2026, trimmed of the CDN URL.
 * The shape is what these tests assert on; the ids, message id and text are
 * placeholders, because the delivery this was taken from belongs to a real
 * person who did not sign up to appear in a public repo.
 */
function delivery(over: Record<string, unknown> = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ACCOUNT,
        time: 1784979653664,
        messaging: [
          {
            sender: { id: SENDER },
            recipient: { id: IG_ACCOUNT },
            timestamp: 1784979652995,
            message: {
              mid: "aWdfbWVzc2FnZUlkOnBsYWNlaG9sZGVy",
              text: "send me the link",
              reply_to: { story: { id: STORY, url: "https://lookaside.fbsbx.com/x" } },
            },
            ...over,
          },
        ],
      },
    ],
  };
}

describe("extractStoryReplies", () => {
  it("reads the delivery Meta actually sent", () => {
    expect(extractStoryReplies(delivery())).toEqual([
      {
        igUserId: IG_ACCOUNT,
        messageId: "aWdfbWVzc2FnZUlkOnBsYWNlaG9sZGVy",
        senderId: SENDER,
        storyId: STORY,
        text: "send me the link",
      },
    ]);
  });

  /**
   * The same reply comes back a second time from the sending side. Treating that
   * as a fresh lead would have the account answering its own message.
   */
  it("skips an echo flagged on the envelope", () => {
    expect(extractStoryReplies(delivery({ is_echo: true }))).toEqual([]);
  });

  it("skips an echo flagged inside the message", () => {
    const payload = delivery();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the fixture
    (payload.entry[0].messaging[0].message as any).is_echo = true;
    expect(extractStoryReplies(payload)).toEqual([]);
  });

  /**
   * Someone opening a conversation is not answering a story, and auto-replying
   * to it would make freeply a bot that DMs anyone who says hello.
   */
  it("ignores an ordinary DM with no story attached", () => {
    const payload = delivery();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the fixture
    delete (payload.entry[0].messaging[0].message as any).reply_to;
    expect(extractStoryReplies(payload)).toEqual([]);
  });

  it("ignores a comment delivery, which uses changes rather than messaging", () => {
    const comments = {
      object: "instagram",
      entry: [
        {
          id: IG_ACCOUNT,
          changes: [{ field: "comments", value: { id: "1", text: "hell ya" } }],
        },
      ],
    };
    expect(extractStoryReplies(comments)).toEqual([]);
  });

  it("survives a message with no text", () => {
    const payload = delivery();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the fixture
    delete (payload.entry[0].messaging[0].message as any).text;
    expect(extractStoryReplies(payload)[0].text).toBe("");
  });

  it("keeps the reply when Meta omits the story id", () => {
    const payload = delivery();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the fixture
    delete (payload.entry[0].messaging[0].message.reply_to.story as any).id;
    const [reply] = extractStoryReplies(payload);
    expect(reply.storyId).toBeUndefined();
    expect(reply.text).toBe("send me the link");
  });
});
