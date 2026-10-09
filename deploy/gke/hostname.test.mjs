// Runs up.sh's own hostname check (the block from the WARDBY_HOSTNAME requirement to its `esac`)
// under bash: a missing, local, or malformed hostname must stop the deploy before anything is
// rendered, and the shell's own HOSTNAME (the machine name) must never stand in for it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(fileURLToPath(new URL("./up.sh", import.meta.url)), "utf8");
const start = script.indexOf(': "${WARDBY_HOSTNAME:?');
const check = script.slice(start, script.indexOf("\nesac\n", start) + "\nesac\n".length);

const run = (env) =>
  spawnSync("bash", ["-c", `set -euo pipefail\n${check}\necho ok`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

describe("deploy/gke/up.sh hostname", () => {
  it("is found in up.sh", () => {
    expect(start).toBeGreaterThan(0);
    expect(script).not.toMatch(/\$\{HOSTNAME[}:]/);
  });

  it("requires WARDBY_HOSTNAME, ignoring the shell's own HOSTNAME", () => {
    const result = run({ HOSTNAME: "laptop.example.com" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/set WARDBY_HOSTNAME/);
  });

  it("accepts a public DNS name", () => {
    expect(run({ WARDBY_HOSTNAME: "app.example.com" }).stdout.trim()).toBe("ok");
  });

  it.each([
    "chriss.macbook.pro.2.lan",
    "box.local",
    "host.internal",
    "localhost",
    "app",
    "https://app.example.com",
    "App.Example.com",
    "app.example.com/mcp",
  ])("refuses %s", (name) => {
    const result = run({ WARDBY_HOSTNAME: name });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("ok");
  });
});
