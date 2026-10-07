import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveQuickstartImages } from "./images.js";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const runtime = `ghcr.io/o/r/wardby-runtime@${digest("a")}`;
const worker = `ghcr.io/o/r/wardby-coding-worker@${digest("b")}`;

function root(): string {
  return mkdtempSync(join(tmpdir(), "wardby-images-"));
}
function writePackageFile(dir: string, body: unknown): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "quickstart-images.json"), typeof body === "string" ? body : JSON.stringify(body));
}
function writeSource(dir: string): void {
  mkdirSync(join(dir, "deploy"), { recursive: true });
  mkdirSync(join(dir, "src", "coding-worker"), { recursive: true });
  writeFileSync(join(dir, "deploy", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(dir, "src", "coding-worker", "Dockerfile"), "FROM scratch\n");
}

describe("resolveQuickstartImages", () => {
  it("prefers both environment overrides", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker });
    expect(
      resolveQuickstartImages({
        env: { WARDBY_RUNTIME_IMAGE: "r:1", CODING_WORKER_IMAGE: "w:1" },
        packageRoot: dir,
      }),
    ).toEqual({ runtime: "r:1", worker: "w:1", source: "env" });
  });

  it("ignores a single environment override", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker });
    expect(resolveQuickstartImages({ env: { WARDBY_RUNTIME_IMAGE: "r:1" }, packageRoot: dir })).toEqual({
      runtime,
      worker,
      source: "package",
    });
  });

  it("uses digest-pinned refs from the package file", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker });
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toEqual({ runtime, worker, source: "package" });
  });

  it("never accepts tag-only refs from the package file", () => {
    const dir = root();
    writePackageFile(dir, { runtime: "ghcr.io/o/r/wardby-runtime:v1", worker });
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toHaveProperty("unavailable");
  });

  it("falls through on malformed package files", () => {
    const dir = root();
    writePackageFile(dir, "not json");
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toHaveProperty("unavailable");
  });

  it("builds locally from a source checkout", () => {
    const dir = root();
    writeSource(dir);
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toEqual({
      runtime: "wardby-runtime:local",
      worker: "wardby-coding-worker:local",
      source: "build",
    });
  });

  it("reports unavailable otherwise", () => {
    const result = resolveQuickstartImages({ env: {}, packageRoot: root() });
    expect(result).toHaveProperty("unavailable");
    expect((result as { unavailable: string }).unavailable).toMatch(/clone of the wardby repository/);
  });
});
