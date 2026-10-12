import { describe, expect, it } from "vitest";
import { loadDependencyCacheConfig } from "./dependency-cache.js";

const MB = 1024 * 1024;
const local = { BLOB_STORE: "local", BLOB_STORE_LOCAL_DIR: "/tmp/blobs" };

describe("loadDependencyCacheConfig", () => {
  it("is off by default and with WARDBY_DEPENDENCY_CACHE=false", () => {
    expect(loadDependencyCacheConfig({})).toEqual({ enabled: false, reason: "disabled" });
    expect(loadDependencyCacheConfig({ ...local, WARDBY_DEPENDENCY_CACHE: "false" })).toEqual({
      enabled: false,
      reason: "disabled",
    });
  });

  it("refuses a value other than true or false", () => {
    expect(() => loadDependencyCacheConfig({ WARDBY_DEPENDENCY_CACHE: "yes" })).toThrow(
      "WARDBY_DEPENDENCY_CACHE must be true or false.",
    );
  });

  it("stays off without a blob store", () => {
    expect(loadDependencyCacheConfig({ WARDBY_DEPENDENCY_CACHE: "true" })).toEqual({
      enabled: false,
      reason: "no_blob_store",
    });
  });

  it("uses the documented defaults", () => {
    expect(loadDependencyCacheConfig({ ...local, WARDBY_DEPENDENCY_CACHE: "true" })).toEqual({
      enabled: true,
      blobStore: { kind: "local", localDir: "/tmp/blobs" },
      maxSnapshotBytes: 1024 * MB,
      repoCapBytes: 4096 * MB,
      totalCapBytes: 20480 * MB,
      maxAgeMs: 14 * 86_400_000,
      uploadMs: 900_000,
    });
  });

  it("reads each limit, and refuses one that is not a positive integer", () => {
    expect(
      loadDependencyCacheConfig({
        ...local,
        WARDBY_DEPENDENCY_CACHE: "true",
        WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB: "10",
        WARDBY_DEPENDENCY_CACHE_REPO_CAP_MB: "20",
        WARDBY_DEPENDENCY_CACHE_TOTAL_CAP_MB: "30",
        WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS: "2",
        WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS: "60",
      }),
    ).toMatchObject({
      maxSnapshotBytes: 10 * MB,
      repoCapBytes: 20 * MB,
      totalCapBytes: 30 * MB,
      maxAgeMs: 2 * 86_400_000,
      uploadMs: 60_000,
    });
    for (const value of ["0", "-1", "1.5", "abc"]) {
      expect(() =>
        loadDependencyCacheConfig({
          ...local,
          WARDBY_DEPENDENCY_CACHE: "true",
          WARDBY_DEPENDENCY_CACHE_REPO_CAP_MB: value,
        }),
      ).toThrow("WARDBY_DEPENDENCY_CACHE_REPO_CAP_MB must be a positive integer.");
    }
  });
});
