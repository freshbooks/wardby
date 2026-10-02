import { describe, expect, it, vi } from "vitest";
import { IssueTrackerError, type IssueTracker, type IssueTrackerRegistry } from "../providers/issue-tracker/types.js";
import {
  AttributionError,
  explicitAttribution,
  validateExplicitIssue,
  linkedPullRequestAttribution,
  linkedPullRequestIssue,
  resolveWorkItem,
  SNAPSHOT_CACHE_MS,
} from "./attribution.js";

const logged = vi.hoisted(() => [] as { level: string; message: string }[]);
vi.mock("./logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at =
      (level: string) =>
      (_payload: unknown, message?: string): void => {
        logged.push({ level, message: message ?? "" });
      };
    return { child: () => make(), debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  };
  return { logger: make() };
});

const NOW = new Date("2026-10-01T12:00:00Z");
const snap = { key: "PAY-241", title: "Refunds", type: "Story", url: "u", scopeKey: "PAY" };

function setup(
  existing: { refreshedAt: Date | null; scopeKey: string; parentKey: string | null } | null,
  snapshot = vi.fn(async () => snap),
) {
  const db = { workItem: { findUnique: vi.fn(async () => existing) } };
  const trackers = { jira: { snapshotIssue: snapshot } as unknown as IssueTracker } as IssueTrackerRegistry;
  return { db, trackers, snapshot };
}

describe("resolveWorkItem", () => {
  it("snapshots when there is no WorkItem yet", async () => {
    const { db, trackers, snapshot } = setup(null);
    const r = await resolveWorkItem(db as never, trackers, "jira", "PAY-241", { now: NOW, timeoutMs: 3000 });
    expect(r).toEqual({ provider: "jira", key: "PAY-241", scopeKey: "PAY", snapshot: snap });
    expect(snapshot).toHaveBeenCalledWith("PAY-241", { timeoutMs: 3000, retryOn429: undefined });
  });

  it("reuses a WorkItem refreshed within the cache window, without calling the tracker", async () => {
    const fresh = new Date(NOW.getTime() - SNAPSHOT_CACHE_MS + 1000);
    const { db, trackers, snapshot } = setup({ refreshedAt: fresh, scopeKey: "PAY", parentKey: "PAY-200" });
    const r = await resolveWorkItem(db as never, trackers, "jira", "PAY-241", { now: NOW });
    expect(snapshot).not.toHaveBeenCalled();
    expect(r.snapshot).toBeNull();
    expect(r.scopeKey).toBe("PAY");
  });

  it("re-snapshots a stale WorkItem", async () => {
    const stale = new Date(NOW.getTime() - SNAPSHOT_CACHE_MS - 1000);
    const { db, trackers, snapshot } = setup({ refreshedAt: stale, scopeKey: "PAY", parentKey: null });
    await resolveWorkItem(db as never, trackers, "jira", "PAY-241", { now: NOW });
    expect(snapshot).toHaveBeenCalledOnce();
  });

  it("returns key-only when the tracker fails, and never throws", async () => {
    const { db, trackers } = setup(
      null,
      vi.fn(async () => {
        throw new IssueTrackerError("tracker_api_error");
      }),
    );
    const r = await resolveWorkItem(db as never, trackers, "jira", "PAY-241", { now: NOW });
    expect(r).toEqual({ provider: "jira", key: "PAY-241", scopeKey: "PAY", snapshot: null });
    expect(logged.at(-1)).toEqual({ level: "warn", message: "issue snapshot failed; attributing by key only" });
  });

  it("returns key-only when no tracker is configured for the provider", async () => {
    const r = await resolveWorkItem(
      { workItem: { findUnique: vi.fn(async () => null) } } as never,
      {},
      "jira",
      "PAY-241",
    );
    expect(r.snapshot).toBeNull();
  });

  it("returns key-only when the WorkItem lookup itself fails", async () => {
    const db = {
      workItem: {
        findUnique: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    };
    const r = await resolveWorkItem(db as never, undefined, "jira", "PAY-241");
    expect(r.snapshot).toBeNull();
    expect(logged.at(-1)).toEqual({ level: "warn", message: "work item lookup failed; attributing by key only" });
  });
});

describe("linkedPullRequestIssue", () => {
  const pr = { codeProvider: "github", repository: "your-org/your-repo", number: 7 };

  it("returns the earliest-linked issue", async () => {
    const findFirst = vi.fn(async () => ({ issueProvider: "jira", issueKey: "PAY-1" }));
    expect(await linkedPullRequestIssue({ issuePullRequest: { findFirst } } as never, pr)).toEqual({
      provider: "jira",
      key: "PAY-1",
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: pr,
      orderBy: { createdAt: "asc" },
      select: { issueProvider: true, issueKey: true },
    });
  });

  it("returns null when the PR has no linked issue", async () => {
    const db = { issuePullRequest: { findFirst: vi.fn(async () => null) } };
    expect(await linkedPullRequestIssue(db as never, pr)).toBeNull();
  });

  it("returns null when the lookup fails", async () => {
    const db = {
      issuePullRequest: {
        findFirst: vi.fn(async () => {
          throw new Error("x");
        }),
      },
    };
    expect(await linkedPullRequestIssue(db as never, pr)).toBeNull();
  });
});

describe("linkedPullRequestAttribution", () => {
  const pr = { codeProvider: "github", repository: "your-org/your-repo", number: 7 };

  it("forwards the snapshot options to the tracker", async () => {
    const snapshotIssue = vi.fn(async () => {
      throw new Error("down");
    });
    const db = {
      issuePullRequest: { findFirst: vi.fn(async () => ({ issueProvider: "jira", issueKey: "PAY-1" })) },
      workItem: { findUnique: vi.fn(async () => null) },
    };
    const out = await linkedPullRequestAttribution(db as never, { jira: { snapshotIssue } } as never, pr, {
      timeoutMs: 2000,
      retryOn429: false,
    });
    expect(snapshotIssue).toHaveBeenCalledWith("PAY-1", { timeoutMs: 2000, retryOn429: false });
    expect(out).toMatchObject({ source: "linked_pr", item: { provider: "jira", key: "PAY-1" } });
  });

  it("is undefined when the PR is unlinked", async () => {
    const db = { issuePullRequest: { findFirst: vi.fn(async () => null) }, workItem: {} };
    expect(await linkedPullRequestAttribution(db as never, undefined, pr)).toBeUndefined();
  });
});

describe("validateExplicitIssue", () => {
  const linked = { agentIssueProject: { findUnique: vi.fn(async () => ({ agentId: "a" })) } };
  const unlinked = { agentIssueProject: { findUnique: vi.fn(async () => null) } };

  it("accepts a well-formed key in a project the agent is linked to", async () => {
    await expect(validateExplicitIssue(linked as never, "a", { provider: "jira", key: "PAY-241" })).resolves.toEqual({
      provider: "jira",
      key: "PAY-241",
    });
    expect(linked.agentIssueProject.findUnique).toHaveBeenCalledWith({
      where: { agentId_provider_projectKey: { agentId: "a", provider: "jira", projectKey: "PAY" } },
      select: { agentId: true },
    });
  });

  it.each([
    [{ provider: "jira", key: "pay-241" }],
    [{ provider: "jira", key: "PAY-0" }],
    [{ provider: "jira" }],
    [{ provider: "linear", key: "ENG-1" }],
    ["PAY-241"],
  ])("rejects malformed input %j", async (issue) => {
    await expect(validateExplicitIssue(linked as never, "a", issue)).rejects.toBeInstanceOf(AttributionError);
  });

  it("rejects a project the agent is not linked to", async () => {
    await expect(validateExplicitIssue(unlinked as never, "a", { provider: "jira", key: "PAY-241" })).rejects.toThrow(
      /not linked/,
    );
  });
});

describe("explicitAttribution", () => {
  it("resolves the work item for a linked issue", async () => {
    const db = {
      agentIssueProject: { findUnique: vi.fn(async () => ({ agentId: "a" })) },
      workItem: { findUnique: vi.fn(async () => null) },
    };
    await expect(
      explicitAttribution(db as never, undefined, "a", { provider: "jira", key: "PAY-241" }),
    ).resolves.toEqual({
      source: "explicit",
      item: { provider: "jira", key: "PAY-241", scopeKey: "PAY", snapshot: null },
    });
  });
});
