import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodingProfileSchema } from "../coding/profile.js";
import { MAX_REPO_PACKAGES, readRepoPackages } from "./repo-packages.js";

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "pipe",
    encoding: "utf8",
  });
const head = () => git("rev-parse", "HEAD").trim();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "repo-packages-")));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function commit(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("add", ".");
  git("commit", "-q", "-m", "files");
}

const PYPROJECT = `[project]\nname = "app"\ndependencies = ["Flask>=3", "zope.interface"]\n[project.optional-dependencies]\ndev = ["pytest"]\n`;

describe("readRepoPackages", () => {
  it("offers a project's [build-system] requires, dropping invalid names", async () => {
    commit({
      "pyproject.toml": `[build-system]\nrequires = ["hatchling>=1.18", "poetry-core>=1.0.0", "bad name!", "flit_core"]\nbuild-backend = "hatchling.build"\n[project]\nname = "a"\ndependencies = ["flask"]\n`,
    });
    const { allowlist, notes } = await readRepoPackages(repo, head());
    expect(notes).toEqual([]);
    expect(allowlist).toEqual({ pypi: ["flask", "flit-core", "hatchling", "poetry-core"] });
  });

  it("offers setuptools and wheel for a pyproject without [build-system]", async () => {
    commit({ "pyproject.toml": `[project]\nname = "a"\ndependencies = ["flask"]\n` });
    expect((await readRepoPackages(repo, head())).allowlist).toEqual({ pypi: ["flask", "setuptools", "wheel"] });
  });

  it("is empty for a repository without manifests", async () => {
    expect(await readRepoPackages(repo, head())).toEqual({ allowlist: {}, notes: [] });
  });

  it("reads pyproject.toml, every requirements*.txt and package.json at the root", async () => {
    commit({
      "pyproject.toml": PYPROJECT,
      "requirements.txt": "flask==3.0.0\nRequests[socks]\n-r requirements-dev.txt\n",
      "requirements-dev.txt": "pytest-cov\nPyTest\n",
      "package.json": JSON.stringify({ dependencies: { express: "^4" }, devDependencies: { "@types/node": "^24" } }),
    });
    const { allowlist, notes } = await readRepoPackages(repo, head());
    expect(notes).toEqual([]);
    // PyPI names are PEP 503-normalized, so Flask/flask and pytest/PyTest are one entry each.
    expect(allowlist).toEqual({
      npm: ["@types/node", "express"],
      pypi: ["flask", "pytest", "pytest-cov", "requests[socks]", "setuptools", "wheel", "zope-interface"],
    });
    expect(() => CodingProfileSchema.parse({ repository: "org/repo", packageAllowlist: allowlist })).not.toThrow();
  });

  it("keeps a package's extras, merged across manifests and normalized", async () => {
    commit({
      "pyproject.toml": `[project]\nname = "a"\ndependencies = ["psycopg[binary]>=3.2", "uvicorn[Standard]"]\n[build-system]\nrequires = ["hatchling"]\n`,
      "requirements.txt": "psycopg\npsycopg[Pool]\nbad[b@d]\n",
    });
    const { allowlist } = await readRepoPackages(repo, head());
    // An invalid extras list drops the extras, never the package.
    expect(allowlist).toEqual({ pypi: ["bad", "hatchling", "psycopg[binary,pool]", "uvicorn[standard]"] });
    expect(() => CodingProfileSchema.parse({ repository: "org/repo", packageAllowlist: allowlist })).not.toThrow();
  });

  it("never offers the repository's own PyPI project, even self-referenced with extras", async () => {
    commit({
      "pyproject.toml": `[project]\nname = "My_Proj"\ndependencies = ["flask"]\n[project.optional-dependencies]\nx = ["httpx"]\nall = ["my.proj[x,y]"]\n[build-system]\nrequires = ["hatchling"]\n`,
      "requirements.txt": "my-proj\nMY_PROJ[x]\nrequests\n",
    });
    const { allowlist } = await readRepoPackages(repo, head());
    expect(allowlist).toEqual({ pypi: ["flask", "hatchling", "httpx", "requests"] });
  });

  it("never offers a Poetry project's own name", async () => {
    commit({
      "pyproject.toml": `[tool.poetry]\nname = "poet"\n[tool.poetry.dependencies]\npython = "^3.12"\nPoet = { version = "*", extras = ["a"] }\nfine = "1"\n[build-system]\nrequires = ["poetry-core"]\n`,
    });
    expect((await readRepoPackages(repo, head())).allowlist).toEqual({ pypi: ["fine", "poetry-core"] });
  });

  it("never offers the root package.json's own name (exact match)", async () => {
    commit({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { app: "1", express: "1" },
        devDependencies: { App: "1" },
      }),
    });
    expect((await readRepoPackages(repo, head())).allowlist).toEqual({ npm: ["App", "express"] });
  });

  it("drops names that are not valid in their ecosystem", async () => {
    commit({
      "package.json": JSON.stringify({ dependencies: { "bad name": "^1", ".hidden": "1", ok: "1", "@Scope/x": "1" } }),
      "pyproject.toml": `[tool.poetry.dependencies]\npython = "^3.12"\n"not valid" = "1"\nfine = "1"\n`,
    });
    expect((await readRepoPackages(repo, head())).allowlist).toEqual({
      npm: ["ok"],
      pypi: ["fine", "setuptools", "wheel"],
    });
  });

  it("ignores manifests that are only in the working tree or the index", async () => {
    writeFileSync(join(repo, "requirements.txt"), "flask\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { express: "1" } }));
    expect((await readRepoPackages(repo, head())).allowlist).toEqual({});
    git("add", ".");
    expect((await readRepoPackages(repo, head())).allowlist).toEqual({});
  });

  it("reads the given commit, not another branch or the checkout", async () => {
    const main = head();
    git("checkout", "-q", "-b", "other");
    commit({ "requirements.txt": "flask\n" });
    expect((await readRepoPackages(repo, main)).allowlist).toEqual({});
    expect((await readRepoPackages(repo, head())).allowlist).toEqual({ pypi: ["flask"] });
  });

  it("ignores manifests below the root and symlinked manifests", async () => {
    commit({ "sub/requirements.txt": "flask\n", "sub/package.json": JSON.stringify({ dependencies: { a: "1" } }) });
    symlinkSync("sub/requirements.txt", join(repo, "requirements.txt"));
    git("add", ".");
    git("commit", "-q", "-m", "link");
    expect((await readRepoPackages(repo, head())).allowlist).toEqual({});
  });

  it("skips a manifest it cannot parse with a note, and still reads the others", async () => {
    commit({
      "pyproject.toml": `[project]\ndependencies = [\n`,
      "package.json": "{ not json",
      "requirements.txt": "flask\n",
    });
    const { allowlist, notes } = await readRepoPackages(repo, head());
    expect(allowlist).toEqual({ pypi: ["flask"] });
    expect(notes).toHaveLength(2);
    expect(notes.join("\n")).toMatch(/pyproject\.toml/);
    expect(notes.join("\n")).toMatch(/package\.json/);
  });

  it("never echoes control characters from the repository in a note", async () => {
    // A quoted TOML key with a \u001b escape decodes to a real ESC byte, which the scan error names.
    commit({
      "pyproject.toml": '[tool.poetry.dependencies]\n"a\\u001b[31m\\u0007" = "1"\n"a\\u001b[31m\\u0007" = "2"\n',
    });
    const { notes } = await readRepoPackages(repo, head());
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/pyproject\.toml/);
    expect(notes[0]).toMatch(/^[\x20-\x7e]*$/);
  });

  it(`offers up to ${MAX_REPO_PACKAGES} names per ecosystem and none above that`, async () => {
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`pkg-${i}`, "1"]));
    commit({
      "package.json": JSON.stringify({ dependencies: many(MAX_REPO_PACKAGES + 1) }),
      "requirements.txt": Object.keys(many(MAX_REPO_PACKAGES)).join("\n"),
    });
    const { allowlist, notes } = await readRepoPackages(repo, head());
    expect(allowlist.npm).toBeUndefined();
    expect(allowlist.pypi).toHaveLength(MAX_REPO_PACKAGES);
    expect(notes).toEqual([
      expect.stringMatching(new RegExp(`${MAX_REPO_PACKAGES + 1} npm packages.*${MAX_REPO_PACKAGES}`)),
    ]);
  });

  it("returns nothing for a commit or folder that cannot be read", async () => {
    expect(await readRepoPackages(repo, "b".repeat(40))).toEqual({ allowlist: {}, notes: [] });
    expect(await readRepoPackages(join(repo, "missing"), "a".repeat(40))).toEqual({ allowlist: {}, notes: [] });
    expect(await readRepoPackages(repo, "HEAD")).toEqual({ allowlist: {}, notes: [] });
  });
});
