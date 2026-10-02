import { describe, expect, it, vi } from "vitest";
import { dedupeLockKey, fileIssue, fingerprintHash, type FileIssueInput } from "./issue-dedupe.js";
import { type IssueTracker, IssueTrackerError, type IssueView } from "../providers/issue-tracker/types.js";

interface Row {
  id: string;
  issueProvider: string;
  projectKey: string;
  fingerprintHash: string;
  issueKey: string;
  agentId: string;
  createdByRunId: string | null;
  seenCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

function fakeDb(rows: Row[] = []) {
  let n = rows.length;
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    issueFingerprint: {
      findFirst: vi.fn(async ({ where }: any) => {
        const hits = rows.filter(
          (r) =>
            r.issueProvider === where.issueProvider &&
            r.projectKey === where.projectKey &&
            r.fingerprintHash === where.fingerprintHash,
        );
        return hits.sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())[0] ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: Row = {
          id: `r${++n}`,
          seenCount: 1,
          firstSeenAt: new Date(Date.now() + n),
          lastSeenAt: new Date(),
          createdByRunId: null,
          ...data,
        };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  };
  const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown, _opts?: unknown) => fn(tx)) };
  return { db: db as any, tx, rows };
}

function view(key: string, statusCategory: IssueView["statusCategory"], projectKey = "OPS"): IssueView {
  return {
    key,
    projectKey,
    summary: "s",
    description: "",
    status: statusCategory === "done" ? "Done" : "Open",
    statusCategory,
    issueType: "Bug",
    priority: null,
    labels: [],
    assignee: null,
    reporter: null,
    url: `https://your-site.atlassian.net/browse/${key}`,
    comments: [],
    commentsTruncated: false,
    attachments: [],
  };
}

function fakeTracker(over: Partial<IssueTracker> = {}): IssueTracker {
  let next = 100;
  return {
    provider: "jira",
    botAccountId: vi.fn(),
    identity: vi.fn(),
    getIssue: vi.fn(async (key: string) => view(key, "new")),
    issueProject: vi.fn(),
    search: vi.fn(),
    matchesJql: vi.fn(),
    comment: vi.fn(async () => ({ id: "c1", url: "u" })),
    editComment: vi.fn(),
    readComment: vi.fn(),
    issueUrl: (k: string) => `https://your-site.atlassian.net/browse/${k}`,
    transitions: vi.fn(),
    transitionTo: vi.fn(),
    editableFields: vi.fn(),
    editFields: vi.fn(),
    linkTypes: vi.fn(async () => [
      { name: "Blocks", inward: "is blocked by", outward: "blocks" },
      { name: "Relates", inward: "relates to", outward: "relates to" },
    ]),
    linkIssues: vi.fn(async () => undefined),
    addRemoteLink: vi.fn(),
    getProperty: vi.fn(),
    setProperty: vi.fn(),
    createMeta: vi.fn(),
    fieldMeta: vi.fn(),
    createIssue: vi.fn(async () => {
      const key = `OPS-${next++}`;
      return { key, url: `https://your-site.atlassian.net/browse/${key}` };
    }),
    readAttachmentText: vi.fn(),
    ...over,
  };
}

const FP = "checkout:TypeError:cart.ts:42";
const link = { provider: "jira", projectKey: "OPS", access: "write" };

function input(tracker: IssueTracker, over: Partial<FileIssueInput> = {}): FileIssueInput {
  return {
    agentId: "a1",
    runId: "run1",
    link,
    tracker,
    fingerprint: FP,
    create: { issueType: "Bug", summary: "Checkout crash", descriptionMarkdown: "It broke." },
    seenAgainMarkdown: "Seen in run run2.",
    ...over,
  };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "old",
    issueProvider: "jira",
    projectKey: "OPS",
    fingerprintHash: fingerprintHash(FP),
    issueKey: "OPS-1",
    agentId: "a1",
    createdByRunId: "run0",
    seenCount: 2,
    firstSeenAt: new Date("2026-09-01"),
    lastSeenAt: new Date("2026-09-02"),
    ...over,
  };
}

describe("fingerprintHash / dedupeLockKey", () => {
  it("hashes to sha256 hex and a stable signed 64-bit key", () => {
    expect(fingerprintHash("x")).toMatch(/^[0-9a-f]{64}$/);
    const key = dedupeLockKey("jira", "OPS", fingerprintHash(FP));
    expect(key).toBe(dedupeLockKey("jira", "OPS", fingerprintHash(FP)));
    expect(key).not.toBe(dedupeLockKey("jira", "WEB", fingerprintHash(FP)));
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  });
});

describe("fileIssue", () => {
  it("creates without a fingerprint, with no row and no lock", async () => {
    const { db, rows } = fakeDb();
    const tracker = fakeTracker();
    const res = await fileIssue({ db }, input(tracker, { fingerprint: undefined }));
    expect(res).toEqual({ outcome: "created", issueKey: "OPS-100", url: expect.any(String), seenCount: 1 });
    expect(tracker.createIssue).toHaveBeenCalledWith(expect.objectContaining({ projectKey: "OPS" }));
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("creates and records the hash (never the raw fingerprint) on first sight, under the lock", async () => {
    const { db, tx, rows } = fakeDb();
    const tracker = fakeTracker();
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "created", issueKey: "OPS-100", seenCount: 1 });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ timeout: 30_000 }));
    expect(rows).toEqual([
      expect.objectContaining({
        fingerprintHash: fingerprintHash(FP),
        issueKey: "OPS-100",
        agentId: "a1",
        createdByRunId: "run1",
      }),
    ]);
    const sent = JSON.stringify((tracker.createIssue as any).mock.calls);
    expect(sent).not.toContain(FP);
  });

  it("comments on an open match and increments the count", async () => {
    const { db, rows } = fakeDb([row()]);
    const tracker = fakeTracker();
    const res = await fileIssue({ db }, input(tracker, { link: { ...link, commentVisibilityRole: "Developers" } }));
    expect(res).toMatchObject({ outcome: "seen_again", issueKey: "OPS-1", seenCount: 3 });
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(tracker.comment).toHaveBeenCalledWith("OPS-1", {
      markdown: "Seen in run run2.\n\nSeen again (×3)",
      visibilityRole: "Developers",
    });
    expect(rows[0].seenCount).toBe(3);
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThan(new Date("2026-09-02").getTime());
  });

  it("files a regression for a Done match: new issue relates to the old, old untouched", async () => {
    const { db, rows } = fakeDb([row()]);
    const tracker = fakeTracker({ getIssue: vi.fn(async (k: string) => view(k, "done")) });
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "regression", issueKey: "OPS-100", seenCount: 1 });
    expect(tracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ descriptionMarkdown: "It broke.\n\nRegression of OPS-1." }),
    );
    expect(tracker.linkIssues).toHaveBeenCalledWith({ type: "Relates", inwardKey: "OPS-1", outwardKey: "OPS-100" });
    expect(tracker.comment).not.toHaveBeenCalled();
    expect(rows[0].seenCount).toBe(2);
    expect(rows).toHaveLength(2);

    // The regression is now the latest: the next sighting comments on it.
    (tracker.getIssue as any).mockImplementation(async (k: string) => view(k, k === "OPS-1" ? "done" : "new"));
    const again = await fileIssue({ db }, input(tracker));
    expect(again).toMatchObject({ outcome: "seen_again", issueKey: "OPS-100", seenCount: 2 });
  });

  it("matches a link type named relates case-insensitively", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({
      getIssue: vi.fn(async (k: string) => view(k, "done")),
      linkTypes: vi.fn(async () => [{ name: "RELATES", inward: "relates to", outward: "relates to" }]),
    });
    await fileIssue({ db }, input(tracker));
    expect(tracker.linkIssues).toHaveBeenCalledWith(expect.objectContaining({ type: "RELATES" }));
  });

  it("skips the link when there is no Relates type, still naming the old issue", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({
      getIssue: vi.fn(async (k: string) => view(k, "done")),
      linkTypes: vi.fn(async () => [{ name: "Blocks", inward: "is blocked by", outward: "blocks" }]),
    });
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "regression" });
    expect(tracker.linkIssues).not.toHaveBeenCalled();
    expect(tracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ descriptionMarkdown: expect.stringContaining("Regression of OPS-1") }),
    );
  });

  it("still reports the regression when linking fails", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({
      getIssue: vi.fn(async (k: string) => view(k, "done")),
      linkIssues: vi.fn(async () => {
        throw new IssueTrackerError("tracker_permission_denied");
      }),
    });
    expect(await fileIssue({ db }, input(tracker))).toMatchObject({ outcome: "regression", issueKey: "OPS-100" });
  });

  it("treats a deleted earlier issue as no match", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({
      getIssue: vi.fn(async () => {
        throw new IssueTrackerError("tracker_not_found");
      }),
    });
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "created", issueKey: "OPS-100" });
    expect(tracker.linkIssues).not.toHaveBeenCalled();
    expect((tracker.createIssue as any).mock.calls[0][0].descriptionMarkdown).toBe("It broke.");
  });

  it("treats an earlier issue that moved out of the project as no match", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({ getIssue: vi.fn(async () => view("OTHER-9", "new", "OTHER")) });
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "created" });
    expect(tracker.comment).not.toHaveBeenCalled();
  });

  it("only matches rows in the same project", async () => {
    const { db } = fakeDb([row({ projectKey: "WEB", issueKey: "WEB-1" })]);
    const tracker = fakeTracker();
    expect(await fileIssue({ db }, input(tracker))).toMatchObject({ outcome: "created" });
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("refuses without a write link", async () => {
    const { db } = fakeDb();
    const tracker = fakeTracker();
    const res = await fileIssue({ db }, input(tracker, { link: { ...link, access: "read" } }));
    expect(res).toMatchObject({ error: "permission_denied" });
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });

  it("rejects an empty or over-long fingerprint", async () => {
    const { db } = fakeDb();
    const tracker = fakeTracker();
    expect(await fileIssue({ db }, input(tracker, { fingerprint: "" }))).toMatchObject({ error: "invalid_arguments" });
    expect(await fileIssue({ db }, input(tracker, { fingerprint: "x".repeat(201) }))).toMatchObject({
      error: "invalid_arguments",
    });
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });

  it("never throws: tracker and database errors come back as results", async () => {
    const tracker = fakeTracker({
      createIssue: vi.fn(async () => {
        throw new IssueTrackerError("tracker_invalid_request", "Missing required field: Component.");
      }),
    });
    expect(await fileIssue({ db: fakeDb().db }, input(tracker))).toEqual({
      error: "tracker_invalid_request",
      message: "Missing required field: Component.",
    });
    const broken = {
      $transaction: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    expect(await fileIssue({ db: broken as any }, input(fakeTracker()))).toEqual({
      error: "internal_error",
      message: "Filing the issue failed.",
    });
  });
});
