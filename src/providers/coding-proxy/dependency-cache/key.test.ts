import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertValidBlobKey } from "../../storage/types.js";
import {
  canonicalJson,
  computePolicyHash,
  deriveSnapshotKey,
  isLockHash,
  newBlobKey,
  parseProjectPath,
  sha256Hex,
} from "./key.js";

const hex = (value: string) => createHash("sha256").update(value).digest("hex");

describe("dependency cache key derivation", () => {
  it("derives the key id from the identity tuple, and a unique blob key per upload", () => {
    const lockHash = hex("lockfile bytes");
    const policyHash = computePolicyHash({ npm: ["react"] }, { minReleaseAgeDays: 3 });
    const parts = {
      repository: "Owner/Repo",
      projectPath: "packages/web",
      lockHash,
      workerImage: "ghcr.io/wardby/worker@sha256:abc",
      policyHash,
    };
    const key = deriveSnapshotKey(parts);
    expect(key).toEqual({
      ecosystem: "npm",
      ...parts,
      keyId: sha256Hex(canonicalJson({ ecosystem: "npm", ...parts })),
    });
    expect(deriveSnapshotKey({ ...parts, projectPath: "." }).keyId).not.toBe(key.keyId);

    const first = newBlobKey(key);
    const second = newBlobKey(key);
    expect(first).not.toBe(second);
    const prefix =
      `dependency-cache/npm/${hex("Owner/Repo")}/${hex("packages/web").slice(0, 16)}/` +
      `${lockHash}-${hex("ghcr.io/wardby/worker@sha256:abc").slice(0, 16)}-${policyHash.slice(0, 16)}-`;
    for (const blobKey of [first, second]) {
      expect(blobKey.startsWith(prefix)).toBe(true);
      expect(blobKey.slice(prefix.length)).toMatch(/^[0-9a-f-]{36}\.tgz$/);
      expect(() => assertValidBlobKey(blobKey)).not.toThrow();
    }
  });

  it("hashes the policy as canonical JSON (key order never matters)", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }], u: undefined })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
    expect(computePolicyHash({ npm: ["a"], pypi: ["b"] }, { x: 1, y: 2 })).toBe(
      computePolicyHash({ pypi: ["b"], npm: ["a"] }, { y: 2, x: 1 }),
    );
    expect(computePolicyHash({ npm: ["a"] }, null)).not.toBe(computePolicyHash({ npm: ["b"] }, null));
    expect(computePolicyHash({}, undefined)).toBe(computePolicyHash({}, null));
    expect(computePolicyHash({}, null)).toBe(hex('{"allowlist":{},"policy":null}'));
  });

  it("accepts only lowercase sha256 hex as a lock hash", () => {
    expect(isLockHash(hex("x"))).toBe(true);
    expect(isLockHash(hex("x").toUpperCase())).toBe(false);
    expect(isLockHash("abc")).toBe(false);
    expect(isLockHash(`${hex("x")}/..`)).toBe(false);
  });

  it.each([
    [undefined, "."],
    [null, "."],
    [".", "."],
    ["web", "web"],
    ["packages/web", "packages/web"],
    ["a/b/c", "a/b/c"],
    ["@scope/pkg", "@scope/pkg"],
  ])("accepts the project path %s", (raw, expected) => {
    expect(parseProjectPath(raw)).toBe(expected);
  });

  it.each([
    "",
    "./web",
    "web/.",
    "web/",
    "/web",
    "a//b",
    "..",
    "../x",
    "a/../b",
    "a/b/c/d",
    "node_modules",
    "a/node_modules/b",
    ".git",
    "a/.hidden",
    "a\\b",
    "a b",
    "web\0",
    "x".repeat(101),
  ])("refuses the project path %j", (raw) => {
    expect(parseProjectPath(raw)).toBeNull();
  });
});
