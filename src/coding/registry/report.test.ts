import { describe, expect, it } from "vitest";
import { acceptedAdvisoriesReason, parseAcceptedAdvisories, summarizeRegistryFetches } from "./report.js";

describe("summarizeRegistryFetches", () => {
  it("dedupes served packages by ecosystem+name+version and refusals by ecosystem+name+reason", () => {
    const row = { reason: null, sizeBytes: null, version: null };
    const summary = summarizeRegistryFetches([
      { ...row, ecosystem: "npm", name: "react", version: "19.0.0", outcome: "served", sizeBytes: 10 },
      { ...row, ecosystem: "npm", name: "react", version: "19.0.0", outcome: "served", sizeBytes: 10 },
      { ...row, ecosystem: "pypi", name: "react", version: "19.0.0", outcome: "served" },
      { ...row, ecosystem: "npm", name: "left-pad", outcome: "refused", reason: "wardby_package_not_allowed" },
      { ...row, ecosystem: "npm", name: "left-pad", outcome: "refused", reason: "wardby_package_not_allowed" },
      { ...row, ecosystem: "npm", name: "left-pad", outcome: "refused", reason: "wardby_version_filtered" },
    ]);
    expect(summary.packages).toEqual([
      { ecosystem: "npm", name: "react", version: "19.0.0", size: 10 },
      { ecosystem: "pypi", name: "react", version: "19.0.0", size: null },
    ]);
    expect(summary.packageRefusals).toEqual([
      { ecosystem: "npm", name: "left-pad", reason: "wardby_package_not_allowed" },
      { ecosystem: "npm", name: "left-pad", reason: "wardby_version_filtered" },
    ]);
  });

  it("carries a served row's accepted-advisories reason onto its package, each id once", () => {
    const row = { sizeBytes: 5, filename: null };
    const summary = summarizeRegistryFetches([
      { ...row, ecosystem: "npm", name: "node-forge", version: "1.4.0", outcome: "served", reason: null },
      {
        ...row,
        ecosystem: "npm",
        name: "node-forge",
        version: "1.4.0",
        outcome: "served",
        reason: "accepted advisories: GHSA-86w9-cpqp-85rv",
      },
      {
        ...row,
        ecosystem: "npm",
        name: "node-forge",
        version: "1.4.0",
        outcome: "served",
        reason: "accepted advisories: GHSA-86w9-cpqp-85rv, GHSA-2nd",
      },
      { ...row, ecosystem: "npm", name: "react", version: "19.0.0", outcome: "served", reason: null },
    ]);
    expect(summary.packages).toEqual([
      {
        ecosystem: "npm",
        name: "node-forge",
        version: "1.4.0",
        size: 5,
        acceptedAdvisories: ["GHSA-86w9-cpqp-85rv", "GHSA-2nd"],
      },
      { ecosystem: "npm", name: "react", version: "19.0.0", size: 5 },
    ]);
  });
});

describe("accepted advisories reason", () => {
  it("round-trips the ids, and is absent with none", () => {
    expect(acceptedAdvisoriesReason(["GHSA-a", "CVE-1"])).toBe("accepted advisories: GHSA-a, CVE-1");
    expect(acceptedAdvisoriesReason([])).toBeUndefined();
    expect(parseAcceptedAdvisories("accepted advisories: GHSA-a, CVE-1")).toEqual(["GHSA-a", "CVE-1"]);
    expect(parseAcceptedAdvisories("wardby_version_filtered")).toEqual([]);
    expect(parseAcceptedAdvisories(null)).toEqual([]);
  });
});
