import { describe, expect, it, vi } from "vitest";
import { collectRunOutcome, outcomeBody } from "./host-status.js";
import { renderEvent, nextStatus } from "./notification-templates.js";
import { emitRunFinishedEvents } from "./workflow-run-events.js";
import { setWorkflowEventSink } from "./workflow-events.js";

const run = { id: "r", status: "succeeded" as const, finalText: null };
const refusals = (reason: string) => [{ ecosystem: "npm", name: "pkg", reason }];

describe("package blocked status", () => {
  it.each(["wardby_graph_incomplete", "wardby_graph_limit", "wardby_package_not_allowed"])(
    "explains %s and how to unblock",
    (code) => {
      const body = outcomeBody(run, "repo", [], [], { packageRefusals: refusals(code) });
      expect(body).toMatch(/^⛔/);
      expect(body).toContain("not on this agent's allowlist");
      expect(body).toContain(code);
      expect(body).toContain("codingProfile.packageAllowlist");
      expect(body).toContain("`@wardby`");
    },
  );
  it.each(["advisory", "release age", "malware"])(
    "explains version filtering for %s without trusting free text",
    () => {
      const body = outcomeBody(run, "repo", [], [], { packageRefusals: refusals("wardby_version_filtered") });
      expect(body).toContain("acceptedAdvisories");
      expect(body).toContain("minReleaseAgeDays");
      expect(body).toContain("Never bypass malware");
    },
  );
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
  it.each(["succeeded", "failed"])(
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
