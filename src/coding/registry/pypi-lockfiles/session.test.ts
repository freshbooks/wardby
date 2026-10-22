import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoetryRunner } from "./session.js";
import { prepareWorkspacePypiLockfiles, restoreWorkspacePypiLockfiles, SNAPSHOT_PATH } from "./session.js";
import { readFileSync } from "node:fs";

const REGISTRY = "http://wardby-proxy:8787/registry/pypi/";
const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/lockfiles/${name}`, import.meta.url), "utf8");

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "wardby-pypi-session-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(workspace, path, ".."), { recursive: true });
  await writeFile(join(workspace, path), content);
}
const read = (path: string): Promise<string> => readFile(join(workspace, path), "utf8");

/** A fake `poetry lock`: rewrites the lock's legacy URLs to whatever the swapped pyproject now names. */
const fakePoetry: PoetryRunner = async ({ projectDir }) => {
  const proxied = (await readFile(join(projectDir, "pyproject.toml"), "utf8")).match(
    /url = "(http:\/\/wardby[^"]*)"/,
  )?.[1];
  const lock = await readFile(join(projectDir, "poetry.lock"), "utf8");
  await writeFile(
    join(projectDir, "poetry.lock"),
    lock
      .replace(/(type = "legacy"\nurl = ")[^"]*(")/g, `$1${proxied}$2`)
      .replace(/content-hash = "0+"/, 'content-hash = "1111"'),
  );
  return { ok: true, stderrTail: "" };
};

const prepare = (run: PoetryRunner = fakePoetry) =>
  prepareWorkspacePypiLockfiles({ workspace, registryUrl: REGISTRY, token: "tok", env: { A: "1" }, run });
const restore = () => restoreWorkspacePypiLockfiles({ workspace, registryUrl: REGISTRY });

describe("uv projects", () => {
  it("rewrites uv.lock, snapshots it privately and restores it exactly", async () => {
    await put("uv.lock", fixture("uv.lock"));
    const result = await prepare();
    expect(result).toEqual({ env: {}, prepared: ["uv.lock"], warnings: [] });
    expect(await read("uv.lock")).toBe(fixture("uv-proxied.lock"));
    expect((await stat(join(workspace, SNAPSHOT_PATH))).mode & 0o777).toBe(0o600);
    expect(await restore()).toEqual({ restored: ["uv.lock"], warnings: [] });
    expect(await read("uv.lock")).toBe(fixture("uv.lock"));
  });

  it("is idempotent: a second prepare changes nothing and keeps the snapshot", async () => {
    await put("uv.lock", fixture("uv.lock"));
    await prepare();
    const snapshot = await read(SNAPSHOT_PATH);
    expect((await prepare()).prepared).toEqual(["uv.lock"]);
    expect(await read(SNAPSHOT_PATH)).toBe(snapshot);
    await restore();
    expect(await read("uv.lock")).toBe(fixture("uv.lock"));
  });

  it("handles nested projects and skips dependency folders, .git and symlinks", async () => {
    await put("services/api/uv.lock", fixture("uv.lock"));
    await put("node_modules/x/uv.lock", fixture("uv.lock"));
    await put(".git/uv.lock", fixture("uv.lock"));
    await put("real/uv.lock", fixture("uv.lock"));
    await symlink(join(workspace, "real/uv.lock"), join(workspace, "link.lock"));
    await symlink(join(workspace, "real/uv.lock"), join(workspace, "uv.lock"));
    expect((await prepare()).prepared).toEqual(["real/uv.lock", "services/api/uv.lock"]);
    expect(await read("node_modules/x/uv.lock")).toBe(fixture("uv.lock"));
    expect(await read(".git/uv.lock")).toBe(fixture("uv.lock"));
    expect(await restore()).toMatchObject({ restored: ["real/uv.lock", "services/api/uv.lock"] });
  });

  it("keeps the file mode", async () => {
    await put("uv.lock", fixture("uv.lock"));
    await chmod(join(workspace, "uv.lock"), 0o640);
    await prepare();
    expect((await stat(join(workspace, "uv.lock"))).mode & 0o777).toBe(0o640);
  });

  it("ignores files that are not uv locks and writes no snapshot when nothing changed", async () => {
    await put("uv.lock", '[[package]]\nname = "x"\n');
    expect(await prepare()).toEqual({ env: {}, prepared: [], warnings: [] });
    await expect(stat(join(workspace, SNAPSHOT_PATH))).rejects.toThrow();
  });

  it("restores what it can of a file the agent changed and warns", async () => {
    await put("uv.lock", fixture("uv.lock"));
    await prepare();
    const added = `\n[[package]]\nname = "idna"\nversion = "3.7"\nsource = { registry = "${REGISTRY}simple" }\n`;
    await writeFile(join(workspace, "uv.lock"), (await read("uv.lock")) + added);
    const result = await restore();
    expect(result.restored).toEqual(["uv.lock"]);
    expect(result.warnings).toEqual([
      expect.stringContaining("uv.lock: changed during the run; 1 entries still name the proxy"),
    ]);
    expect(await read("uv.lock")).toBe(fixture("uv.lock") + added);
  });
});

describe("poetry projects", () => {
  async function poetryProject(directory = ""): Promise<void> {
    await put(`${directory}pyproject.toml`, fixture("poetry-pyproject.toml"));
    await put(`${directory}poetry.lock`, fixture("poetry.lock"));
  }

  it("swaps sources, runs poetry lock, returns credentials and restores both files exactly", async () => {
    await poetryProject();
    const result = await prepare();
    expect(result.prepared).toEqual(["poetry.lock", "pyproject.toml"]);
    expect(result.env).toEqual({
      POETRY_HTTP_BASIC_CORP_USERNAME: "wardby",
      POETRY_HTTP_BASIC_CORP_PASSWORD: "tok",
      POETRY_HTTP_BASIC_PYPI_PUBLIC_USERNAME: "wardby",
      POETRY_HTTP_BASIC_PYPI_PUBLIC_PASSWORD: "tok",
    });
    expect(await read("pyproject.toml")).toContain(`${REGISTRY}simple/`);
    expect(await read("pyproject.toml")).not.toContain("jfrog");
    expect(await restore()).toEqual({ restored: ["poetry.lock", "pyproject.toml"], warnings: [] });
    expect(await read("pyproject.toml")).toBe(fixture("poetry-pyproject.toml"));
    expect(await read("poetry.lock")).toBe(fixture("poetry.lock"));
  });

  it("passes the agent environment plus the credentials to poetry, in the project directory", async () => {
    await poetryProject("svc/");
    const seen: Parameters<PoetryRunner>[0][] = [];
    await prepare(async (options) => {
      seen.push(options);
      return fakePoetry(options);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].projectDir).toBe(join(workspace, "svc"));
    expect(seen[0].env).toMatchObject({ A: "1", POETRY_HTTP_BASIC_CORP_PASSWORD: "tok" });
  });

  it("hands poetry this process's UV_PYTHON_* so it can find a baked interpreter, and lets the agent environment win", async () => {
    vi.stubEnv("UV_PYTHON_INSTALL_DIR", "/opt/uv-python");
    vi.stubEnv("UV_PYTHON_DOWNLOADS", "never");
    await poetryProject();
    const seen: Parameters<PoetryRunner>[0][] = [];
    await prepareWorkspacePypiLockfiles({
      workspace,
      registryUrl: REGISTRY,
      token: "tok",
      env: { UV_PYTHON_DOWNLOADS: "manual" },
      run: async (options) => {
        seen.push(options);
        return fakePoetry(options);
      },
    });
    expect(seen[0].env).toMatchObject({ UV_PYTHON_INSTALL_DIR: "/opt/uv-python", UV_PYTHON_DOWNLOADS: "manual" });
  });

  it("reverts the pyproject swap when poetry lock fails, and reports why", async () => {
    await poetryProject();
    const result = await prepare(async () => ({ ok: false, reason: "failed", stderrTail: "no solution\nfound" }));
    expect(result).toMatchObject({ env: {}, prepared: [] });
    expect(result.warnings).toEqual([expect.stringContaining("pyproject.toml: poetry lock through the proxy failed")]);
    expect(await read("pyproject.toml")).toBe(fixture("poetry-pyproject.toml"));
    expect(await read("poetry.lock")).toBe(fixture("poetry.lock"));
    await expect(stat(join(workspace, SNAPSHOT_PATH))).rejects.toThrow();
  });

  it("skips quietly when poetry is not installed", async () => {
    await poetryProject();
    const result = await prepare(async () => ({ ok: false, reason: "poetry_not_installed", stderrTail: "" }));
    expect(result).toEqual({ env: {}, prepared: [], warnings: [] });
    expect(await read("pyproject.toml")).toBe(fixture("poetry-pyproject.toml"));
  });

  it("leaves a pyproject with no URL sources, or a lock without a Poetry pyproject, alone", async () => {
    await put("a/pyproject.toml", '[tool.poetry]\nname = "x"\n');
    await put("a/poetry.lock", fixture("poetry.lock"));
    await put("b/pyproject.toml", '[project]\nname = "x"\n');
    await put("b/poetry.lock", fixture("poetry.lock"));
    let calls = 0;
    expect(await prepare(async () => (calls++, { ok: true, stderrTail: "" }))).toMatchObject({ prepared: [] });
    expect(calls).toBe(0);
  });

  it("warns when the agent changed the lock", async () => {
    await poetryProject();
    await prepare();
    await writeFile(join(workspace, "poetry.lock"), `${await read("poetry.lock")}# edited\n`);
    const result = await restore();
    expect(result.restored).toEqual(["poetry.lock", "pyproject.toml"]);
    expect(result.warnings).toEqual([
      expect.stringContaining("poetry.lock: changed during the run; run `poetry lock`"),
    ]);
    expect(await read("pyproject.toml")).toBe(fixture("poetry-pyproject.toml"));
  });
});

describe("restoreWorkspacePypiLockfiles", () => {
  it("does nothing without a snapshot", async () => {
    await put("uv.lock", fixture("uv.lock"));
    expect(await restore()).toEqual({ restored: [], warnings: [] });
  });

  it("warns and changes nothing for a corrupt snapshot", async () => {
    await put("uv.lock", fixture("uv-proxied.lock"));
    await put(SNAPSHOT_PATH, "{not json");
    const result = await restore();
    expect(result.restored).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("snapshot is unreadable")]);
    expect(await read("uv.lock")).toBe(fixture("uv-proxied.lock"));
  });

  it("never writes outside the three lockfile names, whatever a tampered snapshot says", async () => {
    await put("notes.txt", "keep");
    await put(
      SNAPSHOT_PATH,
      JSON.stringify({
        schemaVersion: 1,
        files: [
          { path: "notes.txt", kind: "uv", original: "pwned", writtenSha256: "x" },
          { path: "../uv.lock", kind: "uv", original: "pwned", writtenSha256: "x" },
        ],
      }),
    );
    const result = await restore();
    expect(result.restored).toEqual([]);
    expect(await read("notes.txt")).toBe("keep");
  });
});
