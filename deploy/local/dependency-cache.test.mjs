// The quickstart's coding proxy gets a local blob store only when
// WARDBY_DEPENDENCY_CACHE is set; the volume is declared either way.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const compose = readFileSync(fileURLToPath(new URL("./docker-compose.quickstart-coding.yml", import.meta.url)), "utf8");

describe("deploy/local quickstart coding proxy dependency cache", () => {
  it("is off unless WARDBY_DEPENDENCY_CACHE is set", () => {
    expect(compose).toContain("BLOB_STORE: ${WARDBY_DEPENDENCY_CACHE:+local}");
    expect(compose).toContain("WARDBY_DEPENDENCY_CACHE: ${WARDBY_DEPENDENCY_CACHE:-false}");
  });

  it("keeps snapshots on a named volume at the directory the image makes writable", () => {
    expect(compose).toContain("BLOB_STORE_LOCAL_DIR: /var/lib/wardby/blobs");
    expect(compose).toContain("- dependency-cache:/var/lib/wardby/blobs");
    expect(compose).toMatch(/^volumes:\n {2}# .*\n {2}dependency-cache:/m);
    expect(readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8")).toContain(
      "chown node:node /var/lib/wardby/blobs",
    );
  });
});
