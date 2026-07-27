/**
 * Prints the decrypted access token for a connected account.
 *
 *   node scripts/token.mjs <ig_user_id>
 *
 * Debugging aid — the token is a live credential, so pipe it rather than
 * pasting it anywhere it will be recorded.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const igUserId = process.argv[2];
if (!igUserId) {
  console.error("usage: node scripts/token.mjs <ig_user_id>");
  process.exit(1);
}

const secret = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split("\n")
  .find((l) => l.startsWith("ENCRYPTION_KEY="))
  ?.split("=")[1]
  ?.replace(/^"|"$/g, "");

if (!secret) {
  console.error("ENCRYPTION_KEY not found in .dev.vars");
  process.exit(1);
}

const raw = execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "freeply",
    "--remote",
    "--json",
    "--command",
    `SELECT token_encrypted FROM accounts WHERE ig_user_id='${igUserId}'`,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
);

const rows = JSON.parse(raw)[0].results;
if (rows.length === 0) {
  console.error(`no account ${igUserId}`);
  process.exit(1);
}

const combined = Buffer.from(rows[0].token_encrypted, "base64");
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
  "decrypt",
]);
const plaintext = await crypto.subtle.decrypt(
  { name: "AES-GCM", iv: combined.subarray(0, 12) },
  key,
  combined.subarray(12),
);

process.stdout.write(new TextDecoder().decode(plaintext));
