import { describe, expect, it, vi } from "vitest";
import type { IssueTracker } from "../providers/issue-tracker/types.js";
import type { FileIssueInput, FileIssueResult } from "./issue-dedupe.js";
import { errorClass, fileSelfDefect, selfDefectFingerprint, type SelfDefectDb } from "./self-defects.js";

const FINISHED = new Date("2026-10-02T12:00:00.000Z");

interface FakeAgent {
  id: string;
  name: string;
  defectProjectKey: string | null;
  defectIssueType: string | null;
}

interface FakeLink {
  agentId: string;
  provider: string;
  projectKey: string;
  access: string;
  commentVisibilityRole: string | null;
  creatableIssueTypes: string[];
}

const AGENT: FakeAgent = { id: "a1", name: "nightly", defectProjectKey: "OPS", defectIssueType: "Bug" };
const LINK: FakeLink = {
  agentId: "a1",
  provider: "jira",
  projectKey: "OPS",
  access: "write",
  commentVisibilityRole: null,
  creatableIssueTypes: ["bug", "Task"],
};

function fakeDb(opts: { agent?: FakeAgent | null; links?: FakeLink[]; failureCategory?: string | null }) {
  const agent = opts.agent === undefined ? AGENT : opts.agent;
  const links = opts.links ?? [LINK];
  return {
    agent: { findUnique: vi.fn(async ({ where }: any) => (agent && agent.id === where.id ? agent : null)) },
    agentIssueProject: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.agentId_provider_projectKey;
        return (
          links.find(
            (l) => l.agentId === key.agentId && l.provider === key.provider && l.projectKey === key.projectKey,
          ) ?? null
        );
      }),
    },
    codingRun: {
      findUnique: vi.fn(async () =>
        opts.failureCategory === undefined ? null : { failureCategory: opts.failureCategory },
      ),
    },
    $transaction: vi.fn(),
  } as unknown as SelfDefectDb & { agent: { findUnique: ReturnType<typeof vi.fn> } };
}

const tracker = { provider: "jira" } as unknown as IssueTracker;

function run(overrides: Partial<{ status: string; error: string | null }> = {}) {
  return { id: "run1", agentId: "a1", status: "failed", error: null, finishedAt: FINISHED, ...overrides };
}

function filer(result: FileIssueResult = { outcome: "created", issueKey: "OPS-1", url: "u", seenCount: 1 }) {
  return vi.fn(async (_input: FileIssueInput) => result);
}

describe("errorClass", () => {
  it("takes the leading code token, lower-cased", () => {
    expect(errorClass("coding_failure_provider_auth:diag-123")).toBe("coding_failure_provider_auth");
    expect(errorClass("Orphaned: no heartbeat since 2026")).toBe("orphaned");
  });
  it("is unknown for free text, empty or missing errors", () => {
    expect(errorClass("something went wrong: secret")).toBe("unknown");
    expect(errorClass("")).toBe("unknown");
    expect(errorClass(null)).toBe("unknown");
  });
  it("is unknown for secret-, host- or id-shaped prefixes", () => {
    expect(errorClass("ghp_abc123: bad credentials")).toBe("unknown");
    expect(errorClass("sk-ant-api03-xyz: rejected")).toBe("unknown");
    expect(errorClass("db.internal.corp: connection refused")).toBe("unknown");
    expect(errorClass("run-8f3a9c: gone")).toBe("unknown");
    expect(errorClass(`${"a".repeat(40)}: long`)).toBe("unknown");
  });
});

describe("selfDefectFingerprint", () => {
  it("is built from structural fields only", () => {
    expect(selfDefectFingerprint("a1", "failed", "budget")).toBe("self:a1:failed:budget");
  });
});

describe("fileSelfDefect", () => {
  it("files a failed run of an opted-in agent with a fingerprint and no raw error text", async () => {
    const fileIssue = filer();
    const db = fakeDb({});
    const secret = "boom: token sk-123 leaked at /srv/app.js";
    const result = await fileSelfDefect(db, { jira: tracker }, run({ error: `engine_error: ${secret}` }), {
      fileIssue,
    });
    expect(result).toMatchObject({ outcome: "created", issueKey: "OPS-1" });
    expect(fileIssue).toHaveBeenCalledTimes(1);
    const input = fileIssue.mock.calls[0][0];
    expect(input.agentId).toBe("a1");
    expect(input.runId).toBe("run1");
    expect(input.link).toMatchObject({ provider: "jira", projectKey: "OPS", access: "write" });
    expect(input.tracker).toBe(tracker);
    expect(input.fingerprint).toBe("self:a1:failed:engine_error");
    expect(input.create.issueType).toBe("Bug");
    expect(input.create.summary).toBe('wardby agent "nightly": failed (engine_error)');
    expect(input.create.descriptionMarkdown).toContain("run1");
    expect(input.create.descriptionMarkdown).toContain("2026-10-02T12:00:00.000Z");
    expect(input.seenAgainMarkdown).toContain("Run run1 ended failed at 2026-10-02T12:00:00.000Z.");
    expect(input.createAllowed).toBeUndefined();
    const everything = JSON.stringify(input.create) + input.seenAgainMarkdown;
    expect(everything).not.toContain("sk-123");
    expect(everything).not.toContain("boom");
  });

  it("prefers the coding run's failure category", async () => {
    const fileIssue = filer();
    await fileSelfDefect(fakeDb({ failureCategory: "provider_auth" }), { jira: tracker }, run({ status: "lost" }), {
      fileIssue,
    });
    expect(fileIssue.mock.calls[0][0].fingerprint).toBe("self:a1:lost:provider_auth");
  });

  it("ignores an unsafe coding failure category", async () => {
    const fileIssue = filer();
    await fileSelfDefect(fakeDb({ failureCategory: "run-8f3a" }), { jira: tracker }, run({ error: "orphaned: x" }), {
      fileIssue,
    });
    expect(fileIssue.mock.calls[0][0].fingerprint).toBe("self:a1:failed:orphaned");
  });

  it("files lost and budget_exhausted runs too", async () => {
    for (const status of ["lost", "budget_exhausted"]) {
      const fileIssue = filer();
      await fileSelfDefect(fakeDb({}), { jira: tracker }, run({ status }), { fileIssue });
      expect(fileIssue.mock.calls[0][0].fingerprint).toBe(`self:a1:${status}:unknown`);
    }
  });

  it("skips succeeded, cancelled and refused runs without touching the database", async () => {
    for (const status of ["succeeded", "cancelled", "refused", "running"]) {
      const fileIssue = filer();
      const db = fakeDb({});
      expect(await fileSelfDefect(db, { jira: tracker }, run({ status }), { fileIssue })).toBeNull();
      expect(fileIssue).not.toHaveBeenCalled();
      expect(db.agent.findUnique).not.toHaveBeenCalled();
    }
  });

  it("skips an agent that has not opted in", async () => {
    const fileIssue = filer();
    const agent = { ...AGENT, defectProjectKey: null, defectIssueType: null };
    expect(await fileSelfDefect(fakeDb({ agent }), { jira: tracker }, run(), { fileIssue })).toBeNull();
    expect(fileIssue).not.toHaveBeenCalled();
  });

  it("skips without a configured tracker", async () => {
    const fileIssue = filer();
    expect(await fileSelfDefect(fakeDb({}), {}, run(), { fileIssue })).toBeNull();
    expect(fileIssue).not.toHaveBeenCalled();
  });

  it("fails closed without a live write link that allows the issue type", async () => {
    const cases: FakeLink[][] = [
      [],
      [{ ...LINK, access: "read" }],
      [{ ...LINK, creatableIssueTypes: [] }],
      [{ ...LINK, creatableIssueTypes: ["Task"] }],
      [{ ...LINK, projectKey: "OTHER" }],
    ];
    for (const links of cases) {
      const fileIssue = filer();
      expect(await fileSelfDefect(fakeDb({ links }), { jira: tracker }, run(), { fileIssue })).toBeNull();
      expect(fileIssue).not.toHaveBeenCalled();
    }
  });

  it("never throws: a database or filing failure only logs", async () => {
    const db = fakeDb({});
    db.agent.findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(fileSelfDefect(db, { jira: tracker }, run(), { fileIssue: filer() })).resolves.toBeNull();
    const failing = vi.fn(async () => {
      throw new Error("jira down");
    });
    await expect(fileSelfDefect(fakeDb({}), { jira: tracker }, run(), { fileIssue: failing })).resolves.toBeNull();
    const errored = filer({ error: "busy", message: "x" });
    await expect(fileSelfDefect(fakeDb({}), { jira: tracker }, run(), { fileIssue: errored })).resolves.toEqual({
      error: "busy",
      message: "x",
    });
  });

  it("stops waiting after the bound while the filing carries on", async () => {
    let release!: (r: FileIssueResult) => void;
    const slow = vi.fn(() => new Promise<FileIssueResult>((resolve) => (release = resolve)));
    const result = await fileSelfDefect(fakeDb({}), { jira: tracker }, run(), { fileIssue: slow, waitMs: 10 });
    expect(result).toBeNull();
    expect(slow).toHaveBeenCalledTimes(1);
    release({ outcome: "created", issueKey: "OPS-2", url: "u", seenCount: 1 });
  });
});
