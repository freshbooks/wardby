import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../core/logger.js";
import { createViewerEventBus, type ViewerEventBus } from "./event-bus.js";

/** A stand-in pg.Client: LISTEN succeeds; `SELECT 1` follows `health`. */
function fakeClient(health: "ok" | "hang" | "reject") {
  const c = new EventEmitter() as EventEmitter & { queries: string[]; ended: boolean };
  c.queries = [];
  c.ended = false;
  Object.assign(c, {
    connect: async () => {},
    query: (sql: string) => {
      c.queries.push(sql);
      if (sql.startsWith("LISTEN") || health === "ok") return Promise.resolve({ rows: [] });
      if (health === "reject") return Promise.reject(new Error("socket gone"));
      return new Promise(() => {}); // half-open: never answers
    },
    end: () => {
      c.ended = true;
      return health === "hang" ? new Promise(() => {}) : Promise.resolve();
    },
  });
  return c;
}

let bus: ViewerEventBus | undefined;
afterEach(async () => {
  await bus?.close();
  bus = undefined;
  vi.restoreAllMocks();
});

describe("viewer event bus state and health checks", () => {
  it("reports live on the first successful LISTEN", async () => {
    const states: boolean[] = [];
    bus = createViewerEventBus({
      connectionString: "postgres://unused",
      connect: () => fakeClient("ok") as unknown as pg.Client,
    });
    bus.onState((live) => states.push(live));
    bus.subscribe(() => {});
    await vi.waitFor(() => expect(states).toEqual([true]));
    expect(bus.connected()).toBe(true);
  });

  it.each(["hang", "reject"] as const)(
    "drops a connection whose health check fails (%s) and reconnects",
    async (mode) => {
      const info = vi.spyOn(logger, "info");
      const clients: ReturnType<typeof fakeClient>[] = [];
      const states: boolean[] = [];
      bus = createViewerEventBus({
        connectionString: "postgres://unused",
        connect: () => {
          const c = fakeClient(clients.length === 0 ? mode : "ok");
          clients.push(c);
          return c as unknown as pg.Client;
        },
        reconnectDelaysMs: [10],
        healthCheckIntervalMs: 20,
        healthCheckTimeoutMs: 30,
      });
      bus.onState((live) => states.push(live));
      bus.subscribe(() => {});
      await vi.waitFor(() => expect(states).toEqual([true, false, true]), { timeout: 2000 });
      expect(clients).toHaveLength(2);
      expect(clients[0].queries).toContain("SELECT 1");
      expect(clients[0].ended).toBe(true);
      expect(bus.connected()).toBe(true);
      expect(info).toHaveBeenCalledWith(expect.anything(), "viewer event bus reconnected");
      await bus.close();
      expect(bus.connected()).toBe(false);
    },
  );

  it("keeps a healthy connection", async () => {
    const clients: ReturnType<typeof fakeClient>[] = [];
    bus = createViewerEventBus({
      connectionString: "postgres://unused",
      connect: () => {
        const c = fakeClient("ok");
        clients.push(c);
        return c as unknown as pg.Client;
      },
      healthCheckIntervalMs: 10,
      healthCheckTimeoutMs: 50,
    });
    bus.subscribe(() => {});
    await vi.waitFor(() => expect(clients[0]?.queries.filter((q) => q === "SELECT 1").length).toBeGreaterThan(2));
    expect(clients).toHaveLength(1);
    expect(bus.connected()).toBe(true);
  });

  it("stops health checks when the last subscriber leaves", async () => {
    const clients: ReturnType<typeof fakeClient>[] = [];
    bus = createViewerEventBus({
      connectionString: "postgres://unused",
      connect: () => {
        const c = fakeClient("ok");
        clients.push(c);
        return c as unknown as pg.Client;
      },
      healthCheckIntervalMs: 10,
    });
    const unsubscribe = bus.subscribe(() => {});
    await vi.waitFor(() => expect(bus!.connected()).toBe(true));
    unsubscribe();
    await vi.waitFor(() => expect(bus!.connected()).toBe(false));
    const count = clients[0].queries.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(clients[0].queries.length).toBe(count);
  });
});
