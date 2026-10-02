import { describe, expect, it } from "vitest";
import { CostReportInputError, parseCostReportQuery } from "./cost-report.js";

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
