import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Claude tool runner image policy", () => {
  it("pins every stage and contains neither agent runtime nor network client tooling", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const lockfile = await readFile(new URL("./package-lock.json", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    const stages = new Set(from.map((line) => line.split(/\s+/)[3]).filter(Boolean));
    expect(from.length).toBeGreaterThan(1);
    // Every external base is digest-pinned; a later stage may build on an earlier one by name.
    expect(from.every((line) => /@sha256:[0-9a-f]{64}/.test(line) || stages.has(line.split(/\s+/)[1]))).toBe(true);
    expect(dockerfile).not.toContain("claude-agent-sdk");
    expect(dockerfile).not.toContain("ANTHROPIC_API_KEY");
    expect(lockfile).not.toContain("@anthropic-ai/");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("COPY src/coding-worker/npm-shim.mjs /opt/wardby/bin/npm-shim.mjs");
    expect(dockerfile).toContain("/etc/profile.d/wardby-shims.sh");
    expect(dockerfile.match(/AS runtime/g)).toHaveLength(1);
  });

  it("builds the node-python tool runner as a named target, keeping the plain one the default", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    // `docker build` with no --target builds the last stage: the plain Node tool runner.
    expect(from.at(-1)).toMatch(/ AS runtime$/);
    const python = dockerfile.slice(dockerfile.indexOf(" AS node-python"), dockerfile.lastIndexOf("FROM "));
    expect(python).toContain("python3-venv");
    expect(python).toContain("pytest==8.3.4");
    expect(python).toContain("ruff==0.16.7");
    expect(python).toContain("ln -s /usr/bin/python3 /usr/bin/python");
    for (const absent of ["/usr/bin/pip", "/usr/bin/pip3", "/usr/bin/gcc", "/usr/bin/curl"]) {
      expect(python).toContain(`test ! -e ${absent}`);
    }
    expect(python).toContain("USER 10001:10001");
  });
});
