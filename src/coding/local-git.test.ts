import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localGitWrite } from "./local-git.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "local-git-"));
  execFileSync("git", ["init", "-q", dir]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("localGitWrite", () => {
  it("passes input to git on stdin", async () => {
    const oid = (await localGitWrite(dir, ["hash-object", "--stdin"], { input: "hello\n" })).trim();
    expect(oid).toMatch(/^[0-9a-f]{40,64}$/);
  });

  // git can exit before reading stdin (an early error, or a command that never
  // reads it). Writing to the closed pipe raises EPIPE on stdin; unhandled, that
  // is an uncaught exception that crashes the process instead of reporting
  // git's own result through the callback.
  it("reports git's result, never an uncaught EPIPE, when git exits without reading stdin", async () => {
    const input = "x".repeat(4 * 1024 * 1024);
    for (let i = 0; i < 20; i++) {
      await expect(
        localGitWrite(dir, ["rev-parse", "--verify", "--quiet", "refs/heads/nope"], { input }),
      ).rejects.toThrow();
      await expect(localGitWrite(dir, ["rev-parse", "--git-dir"], { input })).resolves.toMatch(/\.git/);
    }
  });

  it("does not write to stdin when there is no input", async () => {
    for (let i = 0; i < 20; i++) {
      await expect(localGitWrite(dir, ["rev-parse", "--git-dir"])).resolves.toMatch(/\.git/);
    }
  });
});
