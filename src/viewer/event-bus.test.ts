import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../core/logger.js";
import { createViewerEventBus, eventBusClientConfig, type ViewerEventBus } from "./event-bus.js";

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

describe("viewer event bus connection config", () => {
  const RDS_URL = "postgresql://app@db.example:5432/w?sslmode=verify-full&sslrootcert=/ca.pem";
  const pgAuth = {
    env: { AWS_REGION: "us-east-1" },
    readFile: () => "CA",
    makeSigner: () => ({ getAuthToken: async () => "t" }),
  };

  it("is today's client config under password auth", () => {
    expect(eventBusClientConfig("postgresql://u:p@h/db?pool_timeout=3", "password")).toEqual({
      connectionString: "postgresql://u:p@h/db?pool_timeout=3",
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      connectionTimeoutMillis: 3_000,
    });
  });

  it("uses explicit fields and a token password under rds-iam", () => {
    const config = eventBusClientConfig(RDS_URL, "rds-iam", pgAuth);
    expect(config.connectionString).toBeUndefined();
    expect(typeof config.password).toBe("function");
    expect(config).toMatchObject({ host: "db.example", user: "app", keepAlive: true, connectionTimeoutMillis: 10_000 });
  });

  it("builds its default client from that config", async () => {
    const configs: pg.ClientConfig[] = [];
    vi.spyOn(pg, "Client").mockImplementation(function (config) {
      configs.push(config as pg.ClientConfig);
      return fakeClient("ok") as unknown as pg.Client;
    });
    const saved = process.env.DATABASE_AUTH;
    delete process.env.DATABASE_AUTH;
    try {
      bus = createViewerEventBus({ connectionString: "postgresql://u:p@h/db" });
    } finally {
      if (saved !== undefined) process.env.DATABASE_AUTH = saved;
    }
    bus.subscribe(() => {});
    await vi.waitFor(() => expect(bus!.connected()).toBe(true));
    expect(configs).toEqual([eventBusClientConfig("postgresql://u:p@h/db", "password")]);

    await bus.close();
    configs.length = 0;
    bus = createViewerEventBus({ connectionString: RDS_URL, auth: "rds-iam", pgAuth });
    bus.subscribe(() => {});
    await vi.waitFor(() => expect(bus!.connected()).toBe(true));
    expect(typeof configs[0]?.password).toBe("function");
    expect(configs[0]?.connectionString).toBeUndefined();
  });

  it("refuses a bad rds-iam URL when the bus is created, not on every reconnect", () => {
    expect(() =>
      createViewerEventBus({ connectionString: "postgresql://app@db.example/w", auth: "rds-iam", pgAuth }),
    ).toThrow("database_auth_invalid");
  });
});
