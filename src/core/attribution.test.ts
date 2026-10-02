import { describe, expect, it, vi } from "vitest";
import { IssueTrackerError, type IssueTracker, type IssueTrackerRegistry } from "../providers/issue-tracker/types.js";
import { resolveWorkItem, SNAPSHOT_CACHE_MS } from "./attribution.js";

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
