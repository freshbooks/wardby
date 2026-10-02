import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import pgModule from "pg";
import { createPrismaClient } from "../core/db.js";
import type { ViewerEvent } from "./api-schema.js";
import { createViewerEventBus } from "./event-bus.js";

const db = createPrismaClient();
const suffix = randomUUID();
const agentId = `bus-agent-${suffix}`;
const runIds: string[] = [];
const newRunId = (label: string) => {
  const id = `bus-run-${label}-${suffix}`;
  runIds.push(id);
  return id;
};

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!process.env.DATABASE_URL)("viewer event bus (PostgreSQL)", () => {
  const url = process.env.DATABASE_URL!;
  const clients: pg.Client[] = [];
  const pids: number[] = [];
  const connect = (cs: string): pg.Client => {
    const client = new pgModule.Client({ connectionString: cs, keepAlive: true });
    clients.push(client);
    const origConnect = client.connect.bind(client);
    // Record this listener's own backend pid once it is up.
    (client as unknown as { connect: () => Promise<void> }).connect = async () => {
      await origConnect();
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      pids.push(rows[0].pid);
    };
    return client;
  };
  const mineOf = (got: ViewerEvent[], id: string) => got.filter((e) => e.runId === id);

  afterAll(async () => {
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("connects lazily, delivers run events, and disconnects when the last subscriber leaves", async () => {
    await db.agent.create({ data: { id: agentId, name: agentId, systemPrompt: "x", model: "m", budgetUsd: 1 } });
    const bus = createViewerEventBus({ connectionString: url, connect });
    expect(clients).toHaveLength(0);
    expect(bus.connected()).toBe(false);

    const got: ViewerEvent[] = [];
    const unsubscribe = bus.subscribe((e) => got.push(e));
    bus.subscribe(() => {
      throw new Error("listener boom"); // must not affect the other listener
    });
    await waitFor(() => bus.connected(), 5000, "connected");

    const runId = newRunId("a");
    await db.run.create({ data: { id: runId, agentId } });
    await waitFor(() => mineOf(got, runId).length > 0, 5000, "run event");
    expect(mineOf(got, runId)[0]).toMatchObject({ kind: "run", runId, agentId, status: "pending" });

    unsubscribe();
    expect(bus.connected()).toBe(true); // one listener (the throwing one) remains
    await bus.close();
    expect(bus.connected()).toBe(false);
  });

  it("closes the connection within 1s of the last unsubscribe", async () => {
    const bus = createViewerEventBus({ connectionString: url, connect });
    const unsubscribe = bus.subscribe(() => {});
    await waitFor(() => bus.connected(), 5000, "connected");
    unsubscribe();
    await waitFor(() => !bus.connected(), 1000, "disconnected");
    await bus.close();
  });

  it("reconnects after its backend is terminated, signals onReconnect, and keeps delivering", async () => {
    const bus = createViewerEventBus({ connectionString: url, connect, reconnectDelaysMs: [50] });
    const got: ViewerEvent[] = [];
    let reconnects = 0;
    bus.onReconnect(() => reconnects++);
    bus.subscribe((e) => got.push(e));
    await waitFor(() => bus.connected(), 5000, "connected");
    const pidBefore = pids[pids.length - 1];

    await db.$executeRaw`SELECT pg_terminate_backend(${pidBefore}::int)`;
    await waitFor(() => reconnects === 1, 5000, "onReconnect");
    await waitFor(() => bus.connected(), 5000, "reconnected");
    expect(pids[pids.length - 1]).not.toBe(pidBefore);

    const runId = newRunId("b");
    await db.run.create({ data: { id: runId, agentId } });
    await waitFor(() => mineOf(got, runId).length > 0, 5000, "post-reconnect event");

    await bus.close();
    expect(bus.connected()).toBe(false);
    // close() leaves no listener backend behind (backend exit is asynchronous).
    const alive = async () => {
      const rows = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE pid = ANY(${pids}::int[])`;
      return Number(rows[0].n);
    };
    const deadline = Date.now() + 2000;
    while ((await alive()) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(await alive()).toBe(0);
  });

  it("does not reconnect after close() during the backoff", async () => {
    const bus = createViewerEventBus({ connectionString: url, connect, reconnectDelaysMs: [300] });
    bus.subscribe(() => {});
    await waitFor(() => bus.connected(), 5000, "connected");
    const before = clients.length;
    await db.$executeRaw`SELECT pg_terminate_backend(${pids[pids.length - 1]}::int)`;
    await waitFor(() => !bus.connected(), 5000, "dropped");
    await bus.close();
    await new Promise((r) => setTimeout(r, 500));
    expect(clients.length).toBe(before);
    expect(bus.connected()).toBe(false);
  });
});
