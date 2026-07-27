import { describe, expect, it } from "vitest";
import { createSession, isValidSession, sessionCookie } from "../../src/auth";

const PASSWORD = "correct-horse-battery-staple";
const OTHER_PASSWORD = "correct-horse-battery-stapl3";

const asHeader = (session: string) => `other=1; ${sessionCookie(session)}`;

describe("session cookies", () => {
  it("accepts a session it just issued", async () => {
    const cookie = asHeader(await createSession(PASSWORD));
    expect(await isValidSession(cookie, PASSWORD)).toBe(true);
  });

  it("rejects a session signed under a different password", async () => {
    const cookie = asHeader(await createSession(OTHER_PASSWORD));
    expect(await isValidSession(cookie, PASSWORD)).toBe(false);
  });

  /**
   * The property the key derivation exists for. If the password were the MAC key,
   * `HMAC(expires, password)` would validate — and a leaked cookie would let an
   * attacker test password guesses offline, at hardware speed, with nothing here
   * to slow them down.
   */
  it("does not validate a MAC taken over the password itself", async () => {
    const expires = String(Date.now() + 60_000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(PASSWORD),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const raw = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expires));
    const mac = [...new Uint8Array(raw)].map((b) => b.toString(16).padStart(2, "0")).join("");

    expect(await isValidSession(asHeader(`${expires}.${mac}`), PASSWORD)).toBe(false);
  });

  it("rejects an expiry that has passed, even correctly signed", async () => {
    // Signed the same way createSession does, but dated to last week.
    const past = String(Date.now() - 1000);
    const valid = await createSession(PASSWORD);
    const mac = valid.split(".")[1];
    expect(await isValidSession(asHeader(`${past}.${mac}`), PASSWORD)).toBe(false);
  });

  it("rejects a tampered expiry", async () => {
    const [expires, mac] = (await createSession(PASSWORD)).split(".");
    const extended = String(Number(expires) + 86_400_000);
    expect(await isValidSession(asHeader(`${extended}.${mac}`), PASSWORD)).toBe(false);
  });

  it("rejects a missing, empty, or malformed cookie", async () => {
    expect(await isValidSession(null, PASSWORD)).toBe(false);
    expect(await isValidSession("", PASSWORD)).toBe(false);
    expect(await isValidSession("freeply_session=", PASSWORD)).toBe(false);
    expect(await isValidSession("freeply_session=nodot", PASSWORD)).toBe(false);
    expect(await isValidSession("unrelated=1", PASSWORD)).toBe(false);
  });
});
