/**
 * An MCP endpoint so a claude.ai connector can read post stats, force the sweep,
 * and write the editorial verdict on a post — nothing here can send a DM, touch
 * a campaign, or read a token out. Least privilege is the point: the workspace
 * dashboard that calls this holds a stats token, not the keys to a live
 * Instagram automation.
 *
 * The DM tools added 2026-08-13 are the largest widening of that surface so far
 * and should be read as such: they expose the operator's own messages, which is
 * more sensitive than any post metric here. Three things keep it bounded, and
 * all three are enforced before a row exists rather than at read time. Only DMs
 * between the operator's OWN accounts are ever stored (`dm_self_ids`, see
 * migration 0017), so a follower's message is not in the table to be returned.
 * The tools read `dm_inbox` and mark rows processed — they cannot read any other
 * thread, and they still cannot send. `backfill_dm_ideas` is the one that
 * reaches Instagram, and it reads conversations only; nothing here writes to a
 * thread.
 *
 * NOT read-only as of 2026-08-12, and the change is deliberate. `set_post_note`
 * writes to `post_notes` and nothing else. Judgements used to live as a literal
 * baked into the dashboard page, which meant recording one required a code edit
 * and a worker deploy — so posts went unjudged and the stale verdicts that did
 * exist stayed wrong for weeks. The write surface is one table of prose about
 * posts; it cannot reach stats, campaigns, tokens, or sends.
 *
 * Speaks stateless streamable-HTTP MCP: single JSON-RPC message per POST,
 * plain application/json back. No SSE, no sessions — every tool here is one
 * D1 read (plus Graph reads for the refresh), so a stream would be ceremony.
 *
 * Auth is its own secret (MCP_STATS_TOKEN), never the dashboard password, and
 * is accepted from either the Authorization header or a /mcp/<token> path —
 * claude.ai custom connectors can't attach a bearer header, so the capability
 * URL is how they get in.
 */

import { constantTimeEqual } from "./auth";
import * as db from "./db";
import { type Env, refreshRecentMediaStats, refreshStaleAccountMedia } from "./index";
import { fetchConversations } from "./instagram";

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "get_post_stats",
    description:
      "Recent Instagram posts with cached stats (views, reach, skip rate, avg watch ms, " +
      "likes, comments, saves, shares), newest first. Stats refresh hourly on their own; " +
      "call refresh_stats first if you need fresher than that.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Posts to return, 1-24. Default 12." },
      },
    },
  },
  {
    name: "refresh_stats",
    description:
      "Force the sweep right now — discover new posts and re-read every stat from " +
      "Instagram, ignoring the cache — then return the fresh stats. Costs ~40 Graph " +
      "API calls; don't loop it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_post_note",
    description:
      "Record the editorial judgement on one post: its format, a short verdict, and the " +
      "reasoning. Upsert, keyed by shortcode (the ABC123 in /reel/ABC123/). This is the " +
      "only write in this server and it touches nothing but the notes table. Put NO " +
      "figures in `status` or `why` — they are prose, nothing refreshes them, and a stale " +
      "sentence beside a live number is worse than no sentence.",
    inputSchema: {
      type: "object",
      properties: {
        shortcode: { type: "string", description: "The ABC123 in /reel/ABC123/. Required." },
        fmt: { type: "string", description: "Format tag, e.g. walkie-talkie, text-wall, tutorial." },
        status: { type: "string", description: "Short verdict shown as a pill, a few words." },
        pill: {
          type: "string",
          description: "Tone: p-good, p-warn, p-debt, or p-mute. Defaults to p-mute.",
        },
        why: { type: "string", description: "The reasoning, one or two sentences." },
      },
      required: ["shortcode"],
    },
  },
  {
    name: "get_stats_at_age",
    description:
      "Every post's reading nearest a given age, so posts are compared at the same point " +
      "in their life instead of settled-against-fresh. Use for 24h/48h/72h/1-week reviews. " +
      "Posts with no snapshot inside the tolerance are omitted, never approximated — the " +
      "history table only starts 2026-08-12, so older posts have no early readings at all.",
    inputSchema: {
      type: "object",
      properties: {
        ageHours: { type: "number", description: "Age to compare at, in hours. Default 24." },
        toleranceHours: {
          type: "number",
          description: "How far off that age a reading may sit and still count. Default 6.",
        },
      },
    },
  },
  {
    name: "get_post_trajectory",
    description:
      "The whole measured curve for one post, oldest reading first — how views, retention " +
      "and engagement moved over time. Answers whether a post spiked and stopped or has a " +
      "tail, which two posts with the same final number can differ on completely.",
    inputSchema: {
      type: "object",
      properties: {
        shortcode: { type: "string", description: "The ABC123 in /reel/ABC123/. Required." },
      },
      required: ["shortcode"],
    },
  },
  {
    name: "list_dm_ideas",
    description:
      "Reel ideas the operator sent themselves between their own two Instagram accounts, " +
      "newest first. Captured from the webhook as they arrive — Instagram only lets the " +
      "API read back the last 20 messages in a thread, so anything not captured live is " +
      "gone. `sharedUrl` may be an expiring CDN link rather than a permalink when the idea " +
      "was sent with share-to-DM instead of a pasted link; treat a missing permalink as " +
      "the platform's limit, not a bug.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Ideas to return, 1-200. Default 25." },
        openOnly: {
          type: "boolean",
          description: "Only ideas not yet folded into the queue. Default true.",
        },
      },
    },
  },
  {
    name: "mark_dm_idea_processed",
    description:
      "Mark one captured DM as folded into the queue so later reads skip it. Keyed by the " +
      "message id from list_dm_ideas. Does not delete anything.",
    inputSchema: {
      type: "object",
      properties: {
        mid: { type: "string", description: "The message id. Required." },
      },
      required: ["mid"],
    },
  },
  {
    name: "backfill_dm_ideas",
    description:
      "One-time seed: read whatever DM history Instagram still exposes and store the parts " +
      "between the operator's own accounts. Reaches at most the 20 most recent messages per " +
      "thread — this cannot recover older history, and no amount of re-running changes that. " +
      "Costs a Graph call per connected account; run it once, not on a schedule.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const rpcResult = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) =>
  json({ jsonrpc: "2.0", id, error: { code, message } });

function authorized(request: Request, path: string, env: Env): boolean {
  if (!env.MCP_STATS_TOKEN) return false;

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer && constantTimeEqual(bearer, env.MCP_STATS_TOKEN)) return true;

  const pathToken = path.startsWith("/mcp/") ? path.slice(5) : "";
  return pathToken !== "" && constantTimeEqual(pathToken, env.MCP_STATS_TOKEN);
}

/**
 * A tool argument as a bounded number.
 *
 * `typeof v === "number"` on its own admits NaN and Infinity, and NaN survives
 * Math.min/Math.max unchanged — so `{"limit": null * 1}` reached D1 as a NaN
 * LIMIT binding rather than being refused or clamped. Anything not finite falls
 * back to the documented default.
 */
function numArg(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

/** The same, for the row counts SQL will only accept as integers. */
function intArg(v: unknown, fallback: number, min: number, max: number): number {
  return Math.trunc(numArg(v, fallback, min, max));
}

async function statsPayload(env: Env, limit: unknown): Promise<string> {
  const rows = await db.postStatsReport(env.DB, intArg(limit, 12, 1, 24));
  return JSON.stringify(rows, null, 2);
}

/**
 * Seeds `dm_inbox` from whatever DM history Instagram still exposes.
 *
 * Reports `reachable` separately from `stored` on purpose. The two differ for a
 * reason the caller has to see: Meta returns at most the 20 most recent messages
 * per thread, so a small number here means the rest is beyond the API, not that
 * the backfill failed. Reporting only "stored 6 ideas" would read as success
 * while silently hiding that months of thread scrolled out of reach.
 */
async function backfillDMIdeas(env: Env): Promise<{
  accounts: number;
  reachable: number;
  stored: number;
  skippedNotSelf: number;
  errors: string[];
  note: string;
}> {
  const selfIds = new Set(await db.selfAccountIds(env.DB));
  const accounts = await db.listAccounts(env.DB);
  const summary = {
    accounts: 0,
    reachable: 0,
    stored: 0,
    skippedNotSelf: 0,
    errors: [] as string[],
    note:
      "Instagram exposes only the last 20 messages per thread; anything older is " +
      "unrecoverable through the API. Re-running does not reach further back.",
  };

  for (const account of accounts) {
    if (account.disconnectedAt !== null) continue;
    const token = await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, account.igUserId);
    if (!token) {
      summary.errors.push(`${account.username}: no token`);
      continue;
    }
    summary.accounts += 1;

    const result = await fetchConversations(token);
    if (!result.ok) {
      summary.errors.push(`${account.username}: ${result.error ?? "unknown error"}`);
      continue;
    }

    for (const m of result.messages) {
      summary.reachable += 1;
      // Whoever isn't the connected account on this message has to be one of
      // the operator's own ids — the same test the webhook path applies.
      const counterparty = m.fromId === account.igUserId ? m.toId : m.fromId;
      if (!counterparty || !selfIds.has(counterparty)) {
        summary.skippedNotSelf += 1;
        continue;
      }

      const createdAt = m.createdTime ? Date.parse(m.createdTime) : Number.NaN;
      const stored = await db.recordDMIdea(env.DB, {
        mid: m.id,
        igUserId: account.igUserId,
        senderId: m.fromId ?? "",
        recipientId: m.toId,
        isEcho: m.fromId === account.igUserId,
        text: m.text,
        // The conversations read asks for no attachment fields (see
        // fetchConversations), so a share backfills as a row with no link.
        attachmentType: null,
        sharedUrl: null,
        sharedMediaId: null,
        rawJson: m.raw,
        receivedAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      });
      if (stored) summary.stored += 1;
    }
  }
  return summary;
}

export async function handleMcp(request: Request, path: string, env: Env): Promise<Response> {
  // An unset token means the feature is off; 404 rather than advertising it.
  if (!env.MCP_STATS_TOKEN) return new Response("not found", { status: 404 });
  if (!authorized(request, path, env)) return new Response("unauthorized", { status: 401 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  let msg: unknown;
  try {
    msg = await request.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, "batching not supported");
  // `null` is valid JSON and destructuring it throws, which turned a malformed
  // body into a 500 instead of the JSON-RPC error the client can actually read.
  // Bare strings and numbers take the same door.
  if (typeof msg !== "object" || msg === null) return rpcError(null, -32600, "invalid request");

  const { id, method, params } = msg as {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
  };

  // Notifications carry no id and expect no body.
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "freeply-stats", version: "1.0.0" },
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const args = params?.arguments ?? {};
      try {
        if (params?.name === "get_post_stats") {
          return rpcResult(id, {
            content: [{ type: "text", text: await statsPayload(env, args.limit) }],
          });
        }
        if (params?.name === "refresh_stats") {
          await refreshStaleAccountMedia(env, 0);
          await refreshRecentMediaStats(env, 0);
          return rpcResult(id, {
            content: [{ type: "text", text: await statsPayload(env, 12) }],
          });
        }
        if (params?.name === "set_post_note") {
          const shortcode = typeof args.shortcode === "string" ? args.shortcode.trim() : "";
          if (!shortcode) return rpcError(id, -32602, "shortcode is required");
          const str = (v: unknown) => (typeof v === "string" ? v : null);
          await db.savePostNote(env.DB, shortcode, {
            fmt: str(args.fmt),
            status: str(args.status),
            pill: str(args.pill) ?? "p-mute",
            why: str(args.why),
          });
          return rpcResult(id, {
            content: [{ type: "text", text: `saved note for ${shortcode}` }],
          });
        }
        if (params?.name === "get_stats_at_age") {
          // A year is past any post this table has readings for, and it is the
          // bound that keeps Infinity from becoming a NaN age in the query.
          const hours = numArg(args.ageHours, 24, 0, 8_760);
          const tol = numArg(args.toleranceHours, 6, 0, 8_760);
          const rows = await db.statsAtAge(env.DB, hours * 3_600_000, tol * 3_600_000);
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          });
        }
        if (params?.name === "get_post_trajectory") {
          const shortcode = typeof args.shortcode === "string" ? args.shortcode.trim() : "";
          if (!shortcode) return rpcError(id, -32602, "shortcode is required");
          const rows = await db.postTrajectory(env.DB, shortcode);
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          });
        }
        if (params?.name === "list_dm_ideas") {
          const limit = intArg(args.limit, 25, 1, 200);
          const openOnly = typeof args.openOnly === "boolean" ? args.openOnly : true;
          const rows = await db.listDMIdeas(env.DB, { limit, openOnly });
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          });
        }
        if (params?.name === "mark_dm_idea_processed") {
          const mid = typeof args.mid === "string" ? args.mid.trim() : "";
          if (!mid) return rpcError(id, -32602, "mid is required");
          const marked = await db.markDMIdeaProcessed(env.DB, mid, Date.now());
          return rpcResult(id, {
            content: [
              { type: "text", text: marked ? `marked ${mid}` : `${mid} was already processed or unknown` },
            ],
          });
        }
        if (params?.name === "backfill_dm_ideas") {
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(await backfillDMIdeas(env), null, 2) }],
          });
        }
        return rpcError(id, -32602, `unknown tool: ${String(params?.name)}`);
      } catch (cause) {
        // The cause stays in the log, never in the reply: a failed Graph read
        // carries the request URL, and that URL carries the access token. The
        // caller holds a stats token, not the account's.
        console.error("mcp tool failed:", cause);
        return rpcResult(id, {
          content: [{ type: "text", text: "tool failed — see worker logs" }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `method not found: ${String(method)}`);
  }
}
