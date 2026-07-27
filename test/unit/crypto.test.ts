import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../../src/crypto";

const KEY = "correct-horse-battery-staple";
const OTHER_KEY = "correct-horse-battery-stapl3";

// Shaped like a long-lived Instagram token; not one.
const TOKEN = `IGAAQ${"x".repeat(180)}ZD`;

describe("encrypt / decrypt", () => {
  it("round-trips a token", async () => {
    expect(await decrypt(await encrypt(TOKEN, KEY), KEY)).toBe(TOKEN);
  });

  it("round-trips awkward values — empty, unicode, and long", async () => {
    for (const value of ["", "🔑 ünïcodé — ok", "a".repeat(4096)]) {
      expect(await decrypt(await encrypt(value, KEY), KEY)).toBe(value);
    }
  });

  it("returns null for the wrong key rather than throwing", async () => {
    const encrypted = await encrypt(TOKEN, KEY);
    expect(await decrypt(encrypted, OTHER_KEY)).toBeNull();
  });

  it("returns null for a corrupted or non-ciphertext value", async () => {
    expect(await decrypt("not base64 at all", KEY)).toBeNull();
    expect(await decrypt("", KEY)).toBeNull();
    // Valid base64, but too short to hold an IV plus a GCM tag.
    expect(await decrypt(btoa("short"), KEY)).toBeNull();

    const encrypted = await encrypt(TOKEN, KEY);
    const tampered = encrypted.slice(0, -4) + (encrypted.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await decrypt(tampered, KEY)).toBeNull();
  });

  // A fresh IV per call. Without it, two accounts holding the same token would
  // produce identical ciphertext and a D1 dump would leak that fact.
  it("produces different ciphertext each time", async () => {
    expect(await encrypt(TOKEN, KEY)).not.toBe(await encrypt(TOKEN, KEY));
  });

  it("accepts a key of any length", async () => {
    for (const key of ["k", "x".repeat(512)]) {
      expect(await decrypt(await encrypt(TOKEN, key), key)).toBe(TOKEN);
    }
  });
});
