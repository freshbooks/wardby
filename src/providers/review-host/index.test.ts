import { describe, expect, it } from "vitest";
import { buildReviewHosts } from "./index.js";

describe("buildReviewHosts", () => {
  it("always registers the local host, so unset roots fail at call time with local_repo_not_allowed", async () => {
    const db = {} as never;
    const hosts = buildReviewHosts({}, db);
    expect(hosts.local).toBeDefined();
    await expect(hosts.local!.listFiles("local:/nowhere/x", undefined)).rejects.toThrow("local_repo_not_allowed");
  });
});
