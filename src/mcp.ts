/**
 * A read-only MCP endpoint so a claude.ai connector can read post stats and
 * force the sweep — nothing here can send a DM, touch a campaign, or read a
 * token out. Least privilege is the point: the workspace dashboard that calls
 * this holds a stats token, not the keys to a live Instagram automation.
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

async function statsPayload(env: Env, limit: number): Promise<string> {
  const rows = await db.postStatsReport(env.DB, Math.min(Math.max(limit, 1), 24));
  return JSON.stringify(rows, null, 2);
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
          const limit = typeof args.limit === "number" ? args.limit : 12;
          return rpcResult(id, {
            content: [{ type: "text", text: await statsPayload(env, limit) }],
          });
        }
        if (params?.name === "refresh_stats") {
          await refreshStaleAccountMedia(env, 0);
          await refreshRecentMediaStats(env, 0);
          return rpcResult(id, {
            content: [{ type: "text", text: await statsPayload(env, 12) }],
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
