/**
 * AES-GCM encryption for access tokens at rest.
 *
 * A D1 dump shouldn't hand someone control of a connected Instagram account, so
 * tokens are encrypted with a key that lives only as a Worker secret.
 */

const IV_BYTES = 12;

async function importKey(secret: string): Promise<CryptoKey> {
  // Hash to exactly 256 bits so any-length secrets work.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  // Prepend the IV so decryption needs nothing but the key.
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(encoded: string, secret: string): Promise<string | null> {
  try {
    const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const key = await importKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, IV_BYTES) },
      key,
      combined.slice(IV_BYTES),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // Wrong key, or the row predates a key rotation.
    return null;
  }
}
