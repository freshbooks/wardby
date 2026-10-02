import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { ViewerEventSchema, type ViewerEvent } from "./api-schema.js";

const db = createPrismaClient();
const suffix = randomUUID();
const agentId = `notify-agent-${suffix}`;
const runId = `notify-run-${suffix}`;
const mine = (e: ViewerEvent) => e.runId === runId;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.DATABASE_URL)("viewer NOTIFY triggers (PostgreSQL)", () => {
  const listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const got: ViewerEvent[] = [];
  const events = () => got.filter(mine);

  beforeAll(async () => {
    await listener.connect();
    listener.on("notification", (m) => {
      const parsed = ViewerEventSchema.parse(JSON.parse(m.payload!));
      got.push(parsed);
    });
    await listener.query("LISTEN wardby_viewer");
  });

  afterAll(async () => {
    await listener.end();
    await db.run.deleteMany({ where: { id: runId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("emits run, service and outcome events, and ignores heartbeat-only updates", async () => {
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    await db.run.create({ data: { id: runId, agentId } });
    await waitFor(() => events().some((e) => e.kind === "run" && e.status === "pending"), 2000);

    await db.run.update({ where: { id: runId }, data: { turns: 3, costUsd: 0.25 } });
    await waitFor(() => events().some((e) => e.kind === "run" && e.turns === 3), 2000);
    const updated = events().find((e) => e.kind === "run" && e.turns === 3);
    expect(updated).toMatchObject({ kind: "run", agentId, costUsd: 0.25, finishedAt: null, parentRunId: null });
    expect(typeof (updated as { costUsd: unknown }).costUsd).toBe("number");

    await db.run.update({
      where: { id: runId },
      data: { status: "succeeded", finishedAt: new Date("2030-01-01T12:00:00.123Z") },
    });
    await waitFor(() => events().some((e) => e.kind === "run" && e.finishedAt !== null), 2000);
    expect(events().find((e) => e.kind === "run" && e.finishedAt !== null)).toMatchObject({
      status: "succeeded",
      finishedAt: "2030-01-01T12:00:00.123Z",
    });

    const before = events().length;
    await db.run.update({ where: { id: runId }, data: { heartbeatAt: new Date() } });
    await sleep(300);
    expect(events().length).toBe(before);

    await db.codingRunServiceStatus.create({ data: { runId, name: "db", state: "probing", attempts: 2 } });
    await waitFor(() => events().some((e) => e.kind === "service"), 2000);
    expect(events().find((e) => e.kind === "service")).toMatchObject({ name: "db", state: "probing", attempts: 2 });

    await db.runIssueStatus.create({ data: { runId, provider: "jira", issueKey: "NTF-1" } });
    await waitFor(() => events().some((e) => e.kind === "outcome"), 2000);
    expect(events().find((e) => e.kind === "outcome")).toMatchObject({ source: "issue_status" });
  });
});
