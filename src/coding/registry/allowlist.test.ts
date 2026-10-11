import { describe, expect, it } from "vitest";
import { MAX_ACCEPTED_ADVISORIES, matchRoot, resolvePolicy } from "./allowlist.js";

describe("matchRoot", () => {
  const entries = [
    { name: "react", wildcard: false, range: "^19" },
    { name: "@heroui/", wildcard: true },
  ];
  it("matches exact names and scope wildcards", () => {
    expect(matchRoot(entries, "react")).toEqual(entries[0]);
    expect(matchRoot(entries, "@heroui/react")).toEqual(entries[1]);
    expect(matchRoot(entries, "@heroui")).toBeUndefined();
    expect(matchRoot(entries, "react-dom")).toBeUndefined();
  });
});

describe("resolvePolicy", () => {
  it("defaults to three days and bounds overrides", () => {
    expect(resolvePolicy(undefined)).toEqual({ minReleaseAgeDays: 3, acceptedAdvisories: [] });
    expect(resolvePolicy({ minReleaseAgeDays: 0 })).toEqual({ minReleaseAgeDays: 0, acceptedAdvisories: [] });
    expect(() => resolvePolicy({ minReleaseAgeDays: 31 })).toThrow();
    expect(() => resolvePolicy({ minReleaseAgeDays: 1.5 })).toThrow();
  });

  it("accepts well-formed advisory ids", () => {
    const ids = ["GHSA-86w9-cpqp-85rv", "CVE-2026-12345", "PYSEC-2026-1"];
    expect(resolvePolicy({ acceptedAdvisories: ids }).acceptedAdvisories).toEqual(ids);
  });

  it("rejects malformed, duplicate, and oversized advisory lists", () => {
    expect(() => resolvePolicy({ acceptedAdvisories: ["ghsa-86w9-cpqp-85rv"] })).toThrow();
    expect(() => resolvePolicy({ acceptedAdvisories: [""] })).toThrow();
    expect(() => resolvePolicy({ acceptedAdvisories: ["CVE-2026-1", "CVE-2026-1"] })).toThrow();
    const many = Array.from({ length: MAX_ACCEPTED_ADVISORIES + 1 }, (_, i) => `CVE-2026-${1000 + i}`);
    expect(() => resolvePolicy({ acceptedAdvisories: many })).toThrow();
  });

  it("never accepts malware advisories", () => {
    expect(() => resolvePolicy({ acceptedAdvisories: ["MAL-2026-1"] })).toThrow(
      "acceptedAdvisories: malware advisories (MAL-…) can never be accepted.",
    );
  });
});
