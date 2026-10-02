/**
 * Viewer HTTP routes: GET /admin/api/graph, /admin/api/runs/:id and the
 * /admin/api/events SSE stream. Read-only and deployment-wide, so every route
 * authenticates and then requires the privileged `admin:view` scope (admin role
 * only) BEFORE touching the database or the event bus. McpErrors propagate to
 * the server's catch (401/403 + WWW-Authenticate).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import type { McpRequestContext } from "../mcp/context.js";
import { requireScope } from "../mcp/auth/resource-server.js";
import { sendJson } from "../mcp/transport/streamable-http.js";
import { DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT, loadGraph, parseSince } from "./graph.js";
import { loadRunDetail } from "./run-detail.js";
import type { ViewerEventBus } from "./event-bus.js";

export const VIEWER_API_PREFIX = "/admin/api/";
export const SSE_HEARTBEAT_MS = 15_000;

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ViewerApiDeps {
  db: PrismaClient;
  bus: ViewerEventBus;
  authenticate: (authorization: string | undefined) => Promise<McpRequestContext>;
  canonicalUri: string;
  heartbeatMs?: number; // tests
}

export interface ViewerApi {
  /** Returns false when the path is not a viewer route (caller falls through to 404). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Ends every open event stream (server shutdown). */
  closeStreams(): void;
}

export function createViewerApi(deps: ViewerApiDeps): ViewerApi {
  const heartbeatMs = deps.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const streams = new Set<() => void>();
  let nextEventId = 0;

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    // The client may have gone while we awaited authentication; its close
    // events already fired and will not fire again, so subscribing now would leak.
    if (req.destroyed || res.destroyed || res.writableEnded) return;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ connected: deps.bus.connected() })}\n\n`);
    const unsubscribe = deps.bus.subscribe((event) => {
      res.write(`id: ${++nextEventId}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const unreconnect = deps.bus.onReconnect(() => res.write("event: resync\ndata: {}\n\n"));
    const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      unsubscribe();
      unreconnect();
      streams.delete(close);
    };
    const close = (): void => {
      cleanup();
      res.end();
    };
    streams.add(close);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  return {
    async handle(req, res, url) {
      const path = url.pathname;
      const runMatch = /^\/admin\/api\/runs\/([^/]*)$/.exec(path);
      const isGraph = path === "/admin/api/graph";
      const isEvents = path === "/admin/api/events";
      if (!isGraph && !isEvents && !runMatch) return false;

      const ctx = await deps.authenticate(req.headers.authorization);
      requireScope(ctx, deps.canonicalUri, "admin:view");

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
        return true;
      }

      if (isGraph) {
        const limitParam = url.searchParams.get("limit");
        let limit = DEFAULT_GRAPH_LIMIT;
        if (limitParam !== null) {
          limit = /^\d{1,6}$/.test(limitParam) ? Number(limitParam) : 0;
          if (limit < 1 || limit > MAX_GRAPH_LIMIT) {
            sendJson(res, 400, { error: "invalid_limit" });
            return true;
          }
        }
        const now = new Date();
        let since: Date;
        try {
          since = parseSince(url.searchParams.get("since"), now);
        } catch {
          sendJson(res, 400, { error: "invalid_since" });
          return true;
        }
        sendJson(res, 200, await loadGraph(deps.db, { since, limit, now }));
        return true;
      }

      if (runMatch) {
        let id = "";
        try {
          id = decodeURIComponent(runMatch[1]);
        } catch {
          /* malformed escape: fails the id check below */
        }
        const detail = RUN_ID.test(id) ? await loadRunDetail(deps.db, id) : null;
        if (!detail) sendJson(res, 404, { error: "not_found" });
        else sendJson(res, 200, detail);
        return true;
      }

      openStream(req, res);
      return true;
    },
    closeStreams() {
      for (const close of [...streams]) close();
    },
  };
}
