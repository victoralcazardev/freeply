import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTokens } from "../../src/cron";
import * as db from "../../src/db";
import { IG_USER_ID } from "../fixtures";

/**
 * The cron with the hardest deadline in the project: a long-lived token dies at
 * ~60 days and there is no recovery except a human re-authorizing. Everything
 * here is about the two decisions that cost an account — calling Meta when it
 * would refuse, and writing off an account over a failure that would have
 * cleared on its own.
 */

const DAY = 86_400_000;
const OLD_TOKEN = "IGAA-token-before-refresh";

let calls: string[] = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Records every outbound URL so a test can assert Meta was never called at all. */
function stubMeta(handler: () => Response) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(input instanceof URL ? input.toString() : String(input));
      return handler();
    }),
  );
}

/**
 * Writes an account with the timestamps a test needs. `upsertAccount` dates
 * everything to now, which is exactly the state that makes a token too young to
 * refresh, so the ages are set afterwards rather than through it.
 */
async function account(
  over: {
    expiresAt?: number | null;
    lastRefreshedAt?: number | null;
    connectedAt?: number;
    needsReconnect?: boolean;
  } = {},
): Promise<void> {
  const now = Date.now();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "cash.builds",
    accessToken: OLD_TOKEN,
    expiresIn: 60 * 24 * 60 * 60,
  });
  await env.DB.prepare(
    `UPDATE accounts
        SET token_expires_at = ?, last_refreshed_at = ?, connected_at = ?, needs_reconnect = ?
      WHERE ig_user_id = ?`,
  )
    .bind(
      over.expiresAt === undefined ? now + 3 * DAY : over.expiresAt,
      over.lastRefreshedAt === undefined ? now - 30 * DAY : over.lastRefreshedAt,
      over.connectedAt ?? now - 40 * DAY,
      over.needsReconnect ? 1 : 0,
      IG_USER_ID,
    )
    .run();
}

async function stored() {
  const row = await env.DB.prepare(
    `SELECT token_expires_at AS expiresAt, needs_reconnect AS needsReconnect,
            reconnect_reason AS reason
       FROM accounts WHERE ig_user_id = ?`,
  )
    .bind(IG_USER_ID)
    .first<{ expiresAt: number | null; needsReconnect: number; reason: string | null }>();
  if (!row) throw new Error("account row vanished");
  return row;
}

const token = () => db.getAccountToken(env.DB, env.ENCRYPTION_KEY, IG_USER_ID);

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM accounts`).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token refresh cron", () => {
  it("renews a token inside the window and records the new expiry", async () => {
    await account();
    stubMeta(() => json(200, { access_token: "IGAA-renewed", expires_in: 60 * 24 * 60 * 60 }));

    await refreshTokens(env);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/refresh_access_token");
    expect(await token()).toBe("IGAA-renewed");

    const row = await stored();
    expect(row.needsReconnect).toBe(0);
    expect(row.expiresAt).toBeGreaterThan(Date.now() + 59 * DAY);
  });

  /**
   * Meta refuses a token under 24 hours old. Asking anyway spends a call and
   * logs a failure that reads like a real one.
   */
  it("does not spend a call on a token Meta would refuse as too new", async () => {
    await account({ lastRefreshedAt: Date.now() - 60 * 60 * 1000 });
    stubMeta(() => json(200, { access_token: "IGAA-renewed" }));

    await refreshTokens(env);

    expect(calls).toHaveLength(0);
    expect(await token()).toBe(OLD_TOKEN);
    expect((await stored()).needsReconnect).toBe(0);
  });

  it("flags an account whose token expired before the cron reached it", async () => {
    await account({ expiresAt: Date.now() - DAY });
    stubMeta(() => json(200, { access_token: "IGAA-renewed" }));

    await refreshTokens(env);

    expect(calls).toHaveLength(0);
    const row = await stored();
    expect(row.needsReconnect).toBe(1);
    expect(row.reason).toMatch(/expired/i);
  });

  /** Code 190 is the token itself. Only a human can fix it, so say so once. */
  it("flags the account when Meta's refusal is final", async () => {
    await account();
    stubMeta(() =>
      json(400, {
        error: { code: 190, type: "OAuthException", message: "Error validating access token" },
      }),
    );

    await refreshTokens(env);

    const row = await stored();
    expect(row.needsReconnect).toBe(1);
    expect(row.reason).toContain("190");
    expect(await token()).toBe(OLD_TOKEN);
  });

  /**
   * The asymmetry that matters. A 500 is Meta having a bad minute; writing the
   * account off for it would demand a reconnect nobody needed, and there are
   * seven daily attempts left inside the window.
   */
  it("leaves a transient failure alone to be retried tomorrow", async () => {
    await account();
    stubMeta(() => json(500, { error: { code: 2, type: "OAuthException", message: "API Service" } }));

    await refreshTokens(env);

    expect(calls).toHaveLength(1);
    const row = await stored();
    expect(row.needsReconnect).toBe(0);
    expect(row.reason).toBeNull();
    expect(await token()).toBe(OLD_TOKEN);
  });

  /**
   * An OAuth response that omitted expires_in leaves a NULL expiry, which no
   * "expires before X" query can ever match. Those accounts are picked up on
   * age instead, or they die silently at 60 days.
   */
  it("picks up a token with no stored expiry once an assumed 60-day life is nearly over", async () => {
    await account({ expiresAt: null, lastRefreshedAt: null, connectedAt: Date.now() - 56 * DAY });
    stubMeta(() => json(200, { access_token: "IGAA-renewed", expires_in: 60 * 24 * 60 * 60 }));

    await refreshTokens(env);

    expect(calls).toHaveLength(1);
    expect(await token()).toBe("IGAA-renewed");
    expect((await stored()).expiresAt).toBeGreaterThan(Date.now() + 59 * DAY);
  });

  it("leaves a token with no stored expiry alone while it is still young", async () => {
    await account({ expiresAt: null, lastRefreshedAt: null, connectedAt: Date.now() - 10 * DAY });
    stubMeta(() => json(200, { access_token: "IGAA-renewed" }));

    await refreshTokens(env);

    expect(calls).toHaveLength(0);
    expect(await token()).toBe(OLD_TOKEN);
  });

  it("stops asking about an account already waiting on a reconnect", async () => {
    await account({ needsReconnect: true });
    stubMeta(() => json(200, { access_token: "IGAA-renewed" }));

    await refreshTokens(env);

    expect(calls).toHaveLength(0);
  });

  /**
   * Regression: a missing expires_in was recorded as 0, which wrote the
   * just-renewed token back as already expired — so the next run marked a
   * perfectly good account dead.
   */
  it("treats a response with no expires_in as another 60 days, not immediate expiry", async () => {
    await account();
    stubMeta(() => json(200, { access_token: "IGAA-renewed" }));

    await refreshTokens(env);

    const row = await stored();
    expect(row.expiresAt).toBeGreaterThan(Date.now() + 59 * DAY);
    expect(row.needsReconnect).toBe(0);
  });
});
