import { describe, expect, it } from "vitest";
import { CostReportInputError, costReport, parseCostReportQuery } from "./cost-report.js";

const NOW = new Date("2026-10-01T00:00:00Z");

describe("parseCostReportQuery", () => {
  it("defaults to issue grouping, the last 30 days and 25 rows", () => {
    expect(parseCostReportQuery({}, NOW)).toEqual({
      groupBy: "issue",
      from: new Date("2026-09-01T00:00:00Z"),
      to: NOW,
      limit: 25,
    });
  });

  it("keeps filters and clamps the limit to 200", () => {
    expect(parseCostReportQuery({ groupBy: "parent", scopeKey: "PAY", limit: 999 }, NOW)).toMatchObject({
      groupBy: "parent",
      scopeKey: "PAY",
      limit: 200,
    });
  });

  it.each([
    [{ groupBy: "epic" }],
    [{ from: "yesterday" }],
    [{ from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }],
    [{ limit: 0 }],
    [{ issueKey: 7 }],
  ])("rejects %j", (args) => {
    expect(() => parseCostReportQuery(args, NOW)).toThrow(CostReportInputError);
  });
});

describe("costReport", () => {
  it("runs every query in one read-only REPEATABLE READ transaction, so rows and totals share a snapshot", async () => {
    const txQueries: string[] = [];
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        txQueries.push(strings.join("?"));
        return [];
      },
      $executeRaw: async (strings: TemplateStringsArray) => {
        txQueries.push(strings.join("?"));
        return 0;
      },
    };
    const options: unknown[] = [];
    const db = {
      $queryRaw: async () => {
        throw new Error("queried outside the snapshot");
      },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>, opts: unknown) => {
        options.push(opts);
        return fn(tx);
      },
    };
    const report = await costReport(db as never, parseCostReportQuery({}, NOW), null);
    expect(report.totals.runs).toBe(0);
    expect(options).toEqual([expect.objectContaining({ isolationLevel: "RepeatableRead" })]);
    expect(txQueries[0]).toMatch(/SET TRANSACTION READ ONLY/);
    expect(txQueries.length).toBeGreaterThan(1);
  });
});
