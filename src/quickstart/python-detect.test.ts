import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectPythonProject } from "./python-detect.js";

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "pipe",
    encoding: "utf8",
  });
const head = () => git("rev-parse", "HEAD").trim();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "python-detect-")));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function commitFile(path: string): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", `add ${path}`);
}

describe("detectPythonProject", () => {
  it.each(["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements.txt", "requirements-dev.txt"])(
    "is Python when %s is committed at the root",
    async (name) => {
      commitFile(name);
      expect(await detectPythonProject(repo, head())).toBe(true);
    },
  );

  it("is not Python without a marker", async () => {
    expect(await detectPythonProject(repo, head())).toBe(false);
  });

  it("ignores markers below the root", async () => {
    commitFile("sub/pyproject.toml");
    expect(await detectPythonProject(repo, head())).toBe(false);
  });

  it("ignores a marker that is only in the working tree", async () => {
    writeFileSync(join(repo, "pyproject.toml"), "x\n");
    expect(await detectPythonProject(repo, head())).toBe(false);
    git("add", "pyproject.toml");
    expect(await detectPythonProject(repo, head())).toBe(false);
  });

  it("ignores a marker that is only on another branch", async () => {
    git("checkout", "-q", "-b", "other");
    commitFile("pyproject.toml");
    git("checkout", "-q", "main");
    expect(await detectPythonProject(repo, head())).toBe(false);
  });

  it("treats a failure as not Python", async () => {
    expect(await detectPythonProject(join(repo, "missing"), "a".repeat(40))).toBe(false);
    expect(await detectPythonProject(repo, "b".repeat(40))).toBe(false);
  });
});
