import { describe, expect, it, vi } from "vitest";
import { collectRunOutcome, completeHostStatus, outcomeBody } from "./host-status.js";
import { completeIssueStatus } from "./issue-status.js";
import { renderEvent, nextStatus } from "./notification-templates.js";
import { emitRunFinishedEvents } from "./workflow-run-events.js";
import { setWorkflowEventSink } from "./workflow-events.js";

const run = { id: "r", status: "succeeded" as const, finalText: null };
const refusals = (reason: string) => [{ ecosystem: "npm", name: "pkg", reason }];

describe("package blocked status", () => {
  it.each([false, true])("preserves a succeeded run's reply despite refusals (replyAsAnswer=%s)", (replyAsAnswer) => {
    const body = outcomeBody({ ...run, finalText: "The answer is ready." }, "repo", [], [], {
      packageRefusals: refusals("wardby_graph_limit"),
      replyAsAnswer,
    });
    expect(body).toMatch(/^✅/);
    expect(body).toContain(replyAsAnswer ? "✅ The answer is ready." : "> The answer is ready.");
    expect(body).toContain("⚠️ **Dependency install incomplete.**");
    expect(body).not.toContain("no changes were made");
  });
  it.each(["failed", "budget_exhausted", "cancelled", "lost", "refused"] as const)(
    "preserves %s wording with refusals",
    (status) => {
      const body = outcomeBody({ ...run, status }, "repo", [], [], {
        packageRefusals: refusals("wardby_graph_limit"),
        budgetSentence: "Out of budget: this run's $2.00 budget was used up.",
      });
      const expected =
        status === "lost"
          ? "Interrupted before it finished"
          : status === "budget_exhausted" || status === "refused"
            ? "Out of budget: this run's $2.00 budget was used up."
            : "Stopped: the run ended with status `" + status + "`.";
      expect(body).toContain(expected);
      expect(body).not.toContain("no changes were made");
    },
  );
  it.each(["github", "jira"] as const)("completes %s status with collected refusals", async (provider) => {
    const update = vi.fn(async () => undefined);
    const editComment = vi.fn(async () => undefined);
    const status = { provider, repository: "repo", issueKey: "PROJ-1", commentId: "comment", completedAt: null };
    const db = {
      runHostStatus: { findUnique: async () => status, update },
      runIssueStatus: { findUnique: async () => status, update },
      agentIssueProject: { findUnique: async () => ({ access: "write" }) },
      $queryRaw: async () => [],
      run: {
        findUnique: async () => ({ agentId: "a" }),
        findMany: async () => [{ id: "c", status: "succeeded", codingRun: { result: { outcome: "no_changes" } } }],
      },
      registryFetch: {
        findMany: vi.fn(async () => [
          { ...refusals("wardby_graph_limit")[0], outcome: "refused", version: null, sizeBytes: null },
        ]),
      },
    };
    if (provider === "github") {
      await completeHostStatus(db as never, run, { github: { editComment } } as never);
      expect(editComment).toHaveBeenCalledWith(
        "repo",
        expect.objectContaining({
          body: expect.stringContaining("no changes were made"),
        }),
      );
    } else {
      await completeIssueStatus(db as never, run, { jira: { editComment } } as never);
      expect(editComment).toHaveBeenCalledWith(
        "PROJ-1",
        "comment",
        expect.objectContaining({
          markdown: expect.stringContaining("no changes were made"),
        }),
      );
    }
    expect(db.registryFetch.findMany).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { commentId: "comment", completedAt: expect.any(Date) },
      }),
    );
  });
  it.each(["failed", "budget_exhausted", "cancelled", "lost", "refused"])(
    "emits run_failed with the reason for %s despite refusals",
    async (status) => {
      const sink = vi.fn();
      setWorkflowEventSink(sink);
      try {
        const db = {
          agent: { findUnique: async () => ({ name: "lead" }) },
          runHostCheck: { findUnique: async () => null },
          run: { findMany: async () => [{ id: "c", status: "succeeded", codingRun: { result: null } }] },
          registryFetch: {
            findMany: async () => [
              { ...refusals("wardby_graph_limit")[0], outcome: "refused", version: null, sizeBytes: null },
            ],
          },
        };
        await emitRunFinishedEvents(db as never, {
          ...run,
          status,
          agentId: "a",
          parentRunId: null,
          error: "failure reason",
        });
        expect(sink).toHaveBeenCalledTimes(1);
        expect(sink).toHaveBeenCalledWith(
          expect.objectContaining({
            dedupeKey: "run_failed:r",
            payload: { kind: "run_failed", agentName: "lead", status, reason: "failure reason" },
          }),
        );
      } finally {
        setWorkflowEventSink(null);
      }
    },
  );
  it.each(["wardby_graph_incomplete", "wardby_graph_limit", "wardby_package_not_allowed"])(
    "explains %s and how to unblock",
    (code) => {
      const body = outcomeBody(run, "repo", [], [], { packageRefusals: refusals(code), noChanges: true });
      expect(body).toMatch(/^⛔/);
      expect(body).toContain("not on this agent's allowlist");
      expect(body).toContain(code);
      expect(body).toContain("codingProfile.packageAllowlist");
      expect(body).toContain("`@wardby`");
    },
  );
  it("explains version filtering without trusting free text", () => {
    const body = outcomeBody(run, "repo", [], [], { packageRefusals: refusals("wardby_version_filtered") });
    expect(body).toContain("acceptedAdvisories");
    expect(body).toContain("minReleaseAgeDays");
    expect(body).toContain("Never bypass malware");
  });
  it("keeps the PR and warns about refused packages", () => {
    const body = outcomeBody(
      run,
      "repo",
      [{ outcome: "pull_request_opened", repository: "repo", pullRequestNumber: 1, codeProvider: "github" }],
      [],
      { packageRefusals: refusals("wardby_graph_limit") },
    );
    expect(body).toContain("Opened #1");
    expect(body).toContain("⚠️");
    expect(body).toContain("`pkg`");
  });
  it("sanitizes, deduplicates and caps refusals, never echoing free text", () => {
    const bad = { ecosystem: "npm", name: "`\n@everyone<@123>", reason: "secret free text" };
    const body = outcomeBody(run, "repo", [], [], {
      packageRefusals: [bad, bad, ...Array.from({ length: 12 }, (_, i) => ({ ...bad, name: `p${i}` }))],
    });
    expect(body).not.toContain("secret free text");
    expect(body).not.toContain("@everyone");
    expect(body).not.toContain("<@123>");
    expect(body).toContain("3 more");
  });
  it("loads all coding children with one query and falls back on read failure", async () => {
    const db = {
      run: { findMany: vi.fn(async () => [{ id: "c", status: "succeeded", codingRun: { result: null } }]) },
      registryFetch: {
        findMany: vi.fn(async () => [
          { ...refusals("wardby_graph_limit")[0], outcome: "refused", version: null, sizeBytes: null },
        ]),
      },
    };
    expect((await collectRunOutcome(db as never, run)).packageRefusals).toEqual(refusals("wardby_graph_limit"));
    expect(db.registryFetch.findMany).toHaveBeenCalledTimes(1);
    db.registryFetch.findMany.mockRejectedValueOnce(new Error("unavailable"));
    expect((await collectRunOutcome(db as never, run)).packageRefusals).toEqual([]);
  });
  it("keeps blocked Slack sections within Slack's text limit", () => {
    const rendered = renderEvent(
      {
        kind: "run_blocked",
        agentName: "lead",
        packageRefusals: Array.from({ length: 10 }, (_, i) => ({
          ecosystem: "npm",
          name: String(i) + "x".repeat(120),
          reason: "wardby_version_filtered",
        })),
      },
      null,
    );
    for (const block of rendered.blocks as { text: { text: string } }[]) {
      expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
  it.each(["succeeded"])(
    "renders shared Slack wording and emits a deduplicated blocked event for %s",
    async (status) => {
      const payload = {
        kind: "run_blocked" as const,
        agentName: "lead",
        packageRefusals: refusals("wardby_graph_limit"),
      };
      expect(renderEvent(payload, null).text).toContain(
        "⛔ **Blocked by the package registry: no changes were made.**",
      );
      expect(nextStatus(null, payload)).toBe("blocked ⛔");
      const sink = vi.fn();
      setWorkflowEventSink(sink);
      try {
        const db = {
          agent: { findUnique: async () => ({ name: "lead" }) },
          runHostCheck: { findUnique: async () => null },
          run: { findMany: async () => [{ id: "c", status: "succeeded", codingRun: { result: null } }] },
          registryFetch: {
            findMany: async () => [
              { ...refusals("wardby_graph_limit")[0], outcome: "refused", version: null, sizeBytes: null },
            ],
          },
        };
        await emitRunFinishedEvents(db as never, { ...run, status, agentId: "a", parentRunId: null, error: null });
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "run_blocked:r", payload }));
      } finally {
        setWorkflowEventSink(null);
      }
    },
  );
});
