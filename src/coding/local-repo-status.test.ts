import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localRepoWarnings } from "./local-repo-status.js";

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-status-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("localRepoWarnings", () => {
  it("is empty for a clean tree", async () => {
    expect(await localRepoWarnings(dir)).toEqual([]);
  });

  it("counts uncommitted files", async () => {
    writeFileSync(join(dir, "a.txt"), "changed");
    writeFileSync(join(dir, "b.txt"), "new");
    expect(await localRepoWarnings(dir)).toEqual(["2 uncommitted files are not included"]);
  });

  it("warns about submodules", async () => {
    writeFileSync(join(dir, ".gitmodules"), '[submodule "x"]\n\tpath = x\n\turl = ../x\n');
    git("add", ".");
    git("commit", "-q", "-m", "mods");
    const warnings = await localRepoWarnings(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/submodules/);
  });

  it("warns about LFS", async () => {
    writeFileSync(join(dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    git("add", ".");
    git("commit", "-q", "-m", "lfs");
    const warnings = await localRepoWarnings(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/LFS/);
  });

  it("never writes the repository's index, even when its stat cache is stale", async () => {
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "a.txt"), future, future);
    const index = join(dir, ".git", "index");
    const before = readFileSync(index);
    expect(await localRepoWarnings(dir)).toEqual([]);
    expect(readFileSync(index).equals(before)).toBe(true);
  });
});
