import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/** A real comment delivery, as Meta sends it. */
const PAYLOAD = {
  object: "instagram",
  entry: [
    {
      id: IG_USER_ID,
      time: 1753300000,
      changes: [
        {
          field: "comments",
          value: {
            id: "18001234567890123",
            text: "link please",
            media: { id: "17900000000000001" },
            from: { id: "78901234567890123", username: "a_commenter" },
          },
        },
      ],
    },
  ],
};

// Two byte sequences, one object. Meta's whitespace is its own business.
const PRETTY = JSON.stringify(PAYLOAD, null, 2);
const COMPACT = JSON.stringify(PAYLOAD);

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function post(body: string, signature?: string): Promise<Response> {
  const request = new Request("https://freeply.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-hub-signature-256": signature } : {}),
    },
    body,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  // The handler answers Meta immediately and finishes the send in waitUntil.
  await waitOnExecutionContext(ctx);
  return response;
}

describe("POST /webhook signature", () => {
  it("accepts a body signed over the bytes that arrived", async () => {
    const response = await post(PRETTY, await sign(PRETTY, FIXTURE_SECRETS.INSTAGRAM_APP_SECRET));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  /**
   * The trap this whole path is built around. Parsing the body and re-serializing
   * it — which any JSON middleware does by default — produces different bytes and
   * therefore a different digest, so every delivery would be rejected as forged.
   */
  it("rejects a re-serialized body, even though the payload is identical", async () => {
    expect(JSON.parse(COMPACT)).toEqual(JSON.parse(PRETTY));
    expect(COMPACT).not.toBe(PRETTY);

    const signature = await sign(PRETTY, FIXTURE_SECRETS.INSTAGRAM_APP_SECRET);
    expect((await post(COMPACT, signature)).status).toBe(403);

    // And the other direction, so this isn't passing by accident.
    const compactSignature = await sign(COMPACT, FIXTURE_SECRETS.INSTAGRAM_APP_SECRET);
    expect((await post(PRETTY, compactSignature)).status).toBe(403);
    expect((await post(COMPACT, compactSignature)).status).toBe(200);
  });

  it("rejects a delivery with no signature header", async () => {
    expect((await post(COMPACT)).status).toBe(403);
  });

  it("rejects a signature that is merely well-formed", async () => {
    expect((await post(COMPACT, `sha256=${"0".repeat(64)}`)).status).toBe(403);
    expect((await post(COMPACT, "sha256=nope")).status).toBe(403);
  });

  // Meta signs Instagram webhooks with the Instagram app secret. Using the Meta
  // app secret looks right, verifies against nothing, and drops every event.
  it("rejects a signature made with the Meta app secret", async () => {
    const wrong = await sign(COMPACT, env.META_APP_SECRET);
    expect((await post(COMPACT, wrong)).status).toBe(403);
  });

  it("rejects a body altered after signing", async () => {
    const signature = await sign(COMPACT, FIXTURE_SECRETS.INSTAGRAM_APP_SECRET);
    const tampered = COMPACT.replace("link please", "link pleasE");
    expect((await post(tampered, signature)).status).toBe(403);
  });
});

describe("GET /webhook subscription check", () => {
  async function get(query: string): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://freeply.test/webhook?${query}`),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("echoes the challenge when the verify token matches", async () => {
    const response = await get(
      `hub.mode=subscribe&hub.verify_token=${FIXTURE_SECRETS.META_VERIFY_TOKEN}` +
        "&hub.challenge=1158201444",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1158201444");
  });

  it("refuses a wrong or missing verify token", async () => {
    expect(
      (await get("hub.mode=subscribe&hub.verify_token=guessed&hub.challenge=1158201444")).status,
    ).toBe(403);
    expect((await get("hub.mode=subscribe&hub.challenge=1158201444")).status).toBe(403);
  });
});
