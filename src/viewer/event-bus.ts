/**
 * Viewer event bus: one raw Postgres connection per server replica that LISTENs
 * on `wardby_viewer` (fed by the viewer NOTIFY triggers) and fans events out to
 * in-process subscribers (the SSE layer).
 *
 * - Lazy: no connection until the first subscriber; closed when the last leaves.
 * - Resilient: Cloud SQL maintenance and proxy restarts drop idle connections,
 *   so the client uses TCP keepAlive and, on error/end while anyone is
 *   subscribed, reconnects on a backoff schedule and re-LISTENs.
 * - Subscribers are not told about the gap; `onReconnect` lets the SSE layer
 *   tell its clients to refetch.
 */
import pg from "pg";
import { poolSettings } from "../core/db.js";
import { logger } from "../core/logger.js";
import { ViewerEventSchema, type ViewerEvent } from "./api-schema.js";

export const VIEWER_CHANNEL = "wardby_viewer";
const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 5000, 10_000];
const WARN_INTERVAL_MS = 60_000;

export interface ViewerEventBus {
  subscribe(listener: (event: ViewerEvent) => void): () => void;
  /** True while the LISTEN connection is up (for the SSE "live" indicator). */
  connected(): boolean;
  /** Fires after the LISTEN connection is re-established following a drop. */
  onReconnect(listener: () => void): () => void;
  close(): Promise<void>;
}

export function createViewerEventBus(options: {
  connectionString: string;
  connect?: (connectionString: string) => pg.Client;
  reconnectDelaysMs?: readonly number[];
}): ViewerEventBus {
  const delays = options.reconnectDelaysMs?.length ? options.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS;
  const makeClient =
    options.connect ??
    ((connectionString: string) =>
      new pg.Client({
        connectionString,
        keepAlive: true,
        connectionTimeoutMillis: poolSettings(connectionString).connectionTimeoutMillis,
      }));

  const listeners = new Set<(event: ViewerEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  let client: pg.Client | null = null; // the current attempt/connection
  let isUp = false;
  let closed = false;
  let dropped = false; // a connection was lost (or failed) in this session
  let attempt = 0;
  let timer: NodeJS.Timeout | null = null;
  const lastWarn = new Map<string, number>();

  function warnThrottled(key: string, message: string, extra: Record<string, unknown> = {}): void {
    const now = Date.now();
    if (now - (lastWarn.get(key) ?? -Infinity) < WARN_INTERVAL_MS) return;
    lastWarn.set(key, now);
    logger.warn(extra, message);
  }

  function dispatch(payload: string | undefined): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload ?? "");
    } catch {
      warnThrottled("invalid", "viewer event bus dropped a non-JSON notification");
      return;
    }
    const result = ViewerEventSchema.safeParse(parsed);
    if (!result.success) {
      warnThrottled("invalid", "viewer event bus dropped an invalid notification");
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(result.data);
      } catch (err) {
        warnThrottled("listener", "viewer event bus listener threw", { err });
      }
    }
  }

  function discard(c: pg.Client): void {
    // Never leave a client without an error handler: late errors must not crash.
    c.on("error", () => {});
    c.end().catch(() => {});
  }

  function scheduleReconnect(): void {
    if (closed || listeners.size === 0 || timer || client) return;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt++;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
    timer.unref();
  }

  function drop(c: pg.Client, err?: unknown): void {
    if (c !== client) return; // stale: already replaced or stopped
    client = null;
    isUp = false;
    dropped = true;
    warnThrottled("connection", "viewer event bus connection lost", err ? { err } : {});
    discard(c);
    scheduleReconnect();
  }

  function open(): void {
    if (closed || client || timer || listeners.size === 0) return;
    const c = makeClient(options.connectionString);
    client = c;
    c.on("notification", (msg) => {
      if (c === client && msg.channel === VIEWER_CHANNEL) dispatch(msg.payload);
    });
    c.on("error", (err) => drop(c, err));
    c.on("end", () => drop(c));
    void (async () => {
      try {
        await c.connect();
        if (c !== client) return discard(c); // stopped while connecting
        await c.query(`LISTEN ${VIEWER_CHANNEL}`);
        if (c !== client) return discard(c);
      } catch (err) {
        return drop(c, err);
      }
      isUp = true;
      attempt = 0;
      if (dropped) {
        dropped = false;
        for (const l of [...reconnectListeners]) {
          try {
            l();
          } catch (err) {
            warnThrottled("listener", "viewer event bus reconnect listener threw", { err });
          }
        }
      }
    })();
  }

  /** Tear down the connection and any pending reconnect. */
  async function stop(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const c = client;
    client = null;
    isUp = false;
    dropped = false;
    attempt = 0;
    if (c) {
      c.on("error", () => {});
      await c.end().catch(() => {});
    }
  }

  return {
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      open();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) void stop();
      };
    },
    connected: () => isUp,
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => {
        reconnectListeners.delete(listener);
      };
    },
    async close() {
      closed = true;
      listeners.clear();
      reconnectListeners.clear();
      await stop();
    },
  };
}
