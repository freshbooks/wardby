/**
 * PostgreSQL: concurrent fileIssue calls with one fingerprint create at most
 * one issue (the advisory transaction lock serialises them).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "./db.js";
import { fileIssue, fingerprintHash } from "./issue-dedupe.js";
import type { IssueTracker, IssueView } from "../providers/issue-tracker/types.js";

const db = createPrismaClient();
/** A unique project key per run, so rows from an aborted earlier run never match. */
const projectKey = `DD${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;

function tracker(): IssueTracker {
  let next = 1;
  const created = new Set<string>();
  const t: Partial<IssueTracker> = {
    provider: "jira",
    createIssue: vi.fn(async () => {
      // Slow enough that unserialised callers would all pass the lookup first.
      await new Promise((r) => setTimeout(r, 50));
      const key = `${projectKey}-${next++}`;
      created.add(key);
      return { key, url: `https://your-site.atlassian.net/browse/${key}` };
    }),
    getIssue: vi.fn(async (key: string) => ({ key, projectKey, statusCategory: "new", url: "u" }) as IssueView),
    comment: vi.fn(async () => ({ id: "c", url: "u" })),
  };
  return t as IssueTracker;
}

describe("fileIssue (PostgreSQL)", () => {
  beforeAll(async () => {
    await db.$connect();
  });
  afterAll(async () => {
    await db.issueFingerprint.deleteMany({ where: { projectKey } });
    await db.$disconnect();
  });

  it("creates once under concurrent calls with the same fingerprint", async () => {
    const t = tracker();
    const call = (i: number) =>
      fileIssue(
        { db },
        {
          agentId: `dd-agent-${i}`,
          runId: null,
          link: { provider: "jira", projectKey, access: "write" },
          tracker: t,
          fingerprint: "svc:Err:frame",
          create: { issueType: "Bug", summary: "s", descriptionMarkdown: "d" },
          seenAgainMarkdown: "again",
        },
      );
    const results = await Promise.all([call(1), call(2), call(3), call(4)]);
    expect(t.createIssue).toHaveBeenCalledTimes(1);
    const outcomes = results.map((r) => ("outcome" in r ? r.outcome : r.error)).sort();
    expect(outcomes).toEqual(["created", "seen_again", "seen_again", "seen_again"]);
    const rows = await db.issueFingerprint.findMany({ where: { projectKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fingerprintHash: fingerprintHash("svc:Err:frame"), seenCount: 4 });
  });
});
