/**
 * Password gate for the dashboard.
 *
 * Cloudflare Access is the better answer and is documented in the README, but it
 * has to be configured by hand — so this exists to make sure the dashboard is
 * never open in the meantime. It holds Instagram tokens.
 */

const COOKIE = "freeply_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

const HMAC = { name: "HMAC", hash: "SHA-256" } as const;
const bytes = (s: string) => new TextEncoder().encode(s);

/**
 * The password is deliberately not the MAC key.
 *
 * A session cookie is an expiry beside its own MAC — known plaintext next to its
 * digest. Signing with the password directly turns any leaked cookie into an
 * offline oracle: guess a password, compute the MAC, compare, repeat as fast as
 * hardware allows, with nothing on our side to rate limit. Deriving a key first
 * means a stolen cookie proves only that a session existed.
 *
 * `npm run init` generates a password far past brute force, but a hand-chosen one
 * is exactly the case this protects, and it's one HMAC to buy it.
 */
async function sessionKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", bytes(secret), HMAC, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, bytes("freeply-session-v1"));
  return crypto.subtle.importKey("raw", derived, HMAC, false, ["sign"]);
}

async function sign(value: string, secret: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await sessionKey(secret), bytes(value));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(secret: string): Promise<string> {
  const expires = String(Date.now() + SESSION_MS);
  return `${expires}.${await sign(expires, secret)}`;
}

export async function isValidSession(
  cookieHeader: string | null,
  secret: string,
): Promise<boolean> {
  const raw = cookieHeader
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

  if (!raw) return false;

  const [expires, mac] = raw.split(".");
  if (!expires || !mac) return false;
  if (Number(expires) < Date.now()) return false;

  return constantTimeEqual(await sign(expires, secret), mac);
}

export function sessionCookie(value: string): string {
  return (
    `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; ` +
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`
  );
}

export const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
