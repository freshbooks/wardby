import { describe, expect, it } from "vitest";

import {
  packageJsonNames,
  packageJsonOwnNames,
  pyprojectNames,
  pyprojectOwnNames,
  requirementName,
  requirementsNames,
} from "./manifests.js";

describe("requirementName (PEP 508)", () => {
  it.each([
    ["flask", "flask"],
    ["Flask>=3.0", "Flask"],
    ["requests[security,socks] >= 2.31 ; python_version < '3.13'", "requests"],
    ["zope.interface~=6.0", "zope.interface"],
    ["typing_extensions", "typing_extensions"],
    ["  pytest  ", "pytest"],
    ["pkg (>=1.0)", "pkg"],
    ["pkg!=1.2,<2", "pkg"],
    ["x", "x"],
  ])("%s -> %s", (spec, name) => {
    expect(requirementName(spec)).toBe(name);
  });

  it.each([
    "pkg @ https://example.com/pkg-1.0.tar.gz",
    "pkg@file:///tmp/pkg",
    "./local/path",
    "../sibling",
    "/abs/path",
    "src/pkg",
    "https://example.com/pkg.whl",
    "git+https://github.com/org/repo.git",
    "dist/pkg-1.0-py3-none-any.whl",
    "pkg-1.0-py3-none-any.whl",
    "pkg-1.0.tar.gz",
    "-e .",
    "",
    "   ",
    "two words",
    "pkg-",
  ])("is null for %j", (spec) => {
    expect(requirementName(spec)).toBeNull();
  });
});

describe("requirementsNames", () => {
  it("takes names from requirement lines and skips everything else", () => {
    const text = [
      "# a comment",
      "",
      "flask>=3.0  # web framework",
      "requests[security]==2.31.0 ; python_version >= '3.8'",
      "-r requirements-base.txt",
      "-c constraints.txt",
      "-e git+https://github.com/org/repo.git#egg=repo",
      "-e .",
      "--index-url https://pypi.org/simple",
      "--extra-index-url=https://example.com/simple",
      "--hash=sha256:abc",
      "https://example.com/pkg-1.0.tar.gz",
      "./vendor/pkg",
      "pkg @ https://example.com/pkg.whl",
      "gunicorn==21.2.0 \\",
      "    --hash=sha256:aaaa \\",
      "    --hash=sha256:bbbb",
      "Werkzeug",
      "\tpytest-cov",
    ].join("\r\n");
    expect(requirementsNames(text)).toEqual(["flask", "requests[security]", "gunicorn", "Werkzeug", "pytest-cov"]);
  });

  it("keeps the extras a requirement names, as written", () => {
    expect(requirementsNames("psycopg[binary,pool]>=3.2\nuvicorn [standard]\nplain\n")).toEqual([
      "psycopg[binary,pool]",
      "uvicorn[standard]",
      "plain",
    ]);
  });

  it("is empty for an empty file", () => {
    expect(requirementsNames("")).toEqual([]);
  });

  it("does not treat a # inside a URL fragment line as a requirement", () => {
    expect(requirementsNames("git+https://x/y.git#egg=y\n")).toEqual([]);
  });
});

// A pyproject with no [build-system] table is built by the legacy setuptools backend.
const LEGACY = ["setuptools", "wheel"];

describe("pyprojectNames", () => {
  it("reads [project] dependencies and every optional-dependencies group", () => {
    const text = `
[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "app"
version = "1.0"
description = """A multi-line
description with "quotes" and [brackets] = signs"""
requires-python = ">=3.10"
authors = [{ name = "A", email = "a@example.com" }]
dependencies = [
  "Flask>=3.0",  # comment after an entry
  'redis[hiredis] >= 5 ; sys_platform != "win32"',
  # a comment line inside the array
  "psycopg[binary]",
  "pkg @ https://example.com/pkg.tar.gz",
  "escaped\\u0041name",
]

[project.optional-dependencies]
dev = ["pytest>=8", "ruff"]
docs = [
  "mkdocs",
]

[project.scripts]
app = "app.cli:main"

[tool.ruff]
line-length = 100
select = ["E", "F"]
`;
    expect(pyprojectNames(text)).toEqual([
      "Flask",
      "redis[hiredis]",
      "psycopg[binary]",
      "escapedAname",
      "pytest",
      "ruff",
      "mkdocs",
      "setuptools",
      "wheel",
    ]);
  });

  it("reads [build-system] requires but not dependencies from other tables", () => {
    const text = `
[build-system]
requires = ["setuptools>=61", "wheel", "poetry-core>=1.0.0", "flit_core", "scikit-build-core", "pkg @ https://x/y.tar.gz"]
[tool.other]
dependencies = ["not-this"]
[tool.poetry.extras]
dependencies = ["nor-this"]
`;
    expect(pyprojectNames(text)).toEqual(["setuptools", "wheel", "poetry-core", "flit_core", "scikit-build-core"]);
  });

  it("adds setuptools and wheel when there is no [build-system] table", () => {
    expect(pyprojectNames(`[project]\nname = "a"\ndependencies = ["flask"]\n`)).toEqual([
      "flask",
      "setuptools",
      "wheel",
    ]);
  });

  it("does not add the legacy backend when [build-system] exists", () => {
    expect(pyprojectNames(`[build-system]\nrequires = ["hatchling"]\n[project]\ndependencies = ["flask"]\n`)).toEqual([
      "flask",
      "hatchling",
    ]);
  });

  it("reads dotted and inline-table optional-dependencies under [project]", () => {
    expect(
      pyprojectNames(
        `[project]\nname = "a"\noptional-dependencies.dev = ["pytest"]\noptional-dependencies.lint = ['ruff']\n`,
      ),
    ).toEqual(["pytest", "ruff", ...LEGACY]);
    expect(pyprojectNames(`[project]\noptional-dependencies = { dev = ["pytest"], docs = ["mkdocs"] }\n`)).toEqual([
      "pytest",
      "mkdocs",
      ...LEGACY,
    ]);
  });

  it("keeps Poetry extras only when they are a list of strings", () => {
    const text = `[tool.poetry.dependencies]\npython = "^3.12"\na = { version = "1", extras = ["x", "y"] }\nb = { version = "1", extras = "x" }\nc = [{ version = "<2", extras = ["p"] }, { version = ">=2", extras = ["q"] }]\n`;
    expect(pyprojectNames(text)).toEqual(["a[x,y]", "b", "c[p,q]", ...LEGACY]);
  });

  it("reads Poetry dependencies (not python), groups, and legacy dev-dependencies", () => {
    const text = `
[tool.poetry]
name = "app"
packages = [{ include = "app" }]

[tool.poetry.dependencies]
python = "^3.11"
flask = "^3.0"
"Flask-Login" = { version = "^0.6", optional = true }
sqlalchemy = { version = "^2.0", extras = ["asyncio"] }
local-lib = { path = "../local-lib", develop = true }
forked = { git = "https://github.com/org/forked.git", branch = "main" }
wheel-dep = { url = "https://example.com/wheel-dep-1.0.whl" }
numpy = [
  { version = "<2", python = "<3.12" },
  { version = ">=2", python = ">=3.12" },
]

[tool.poetry.dependencies.celery]
version = "^5"
extras = ["redis"]

[tool.poetry.group.dev.dependencies]
pytest = "^8"

[tool.poetry.group."lint".dependencies]
ruff = "*"

[tool.poetry.dev-dependencies]
black = "^24"

[[tool.poetry.source]]
name = "private"
url = "https://example.com/simple"
`;
    expect(pyprojectNames(text)).toEqual([
      "flask",
      "Flask-Login",
      "sqlalchemy[asyncio]",
      "numpy",
      "celery[redis]",
      "pytest",
      "ruff",
      "black",
      ...LEGACY,
    ]);
  });

  it("skips Poetry subtables that point at a path or git source", () => {
    const text = `[tool.poetry.dependencies.mine]\npath = "./mine"\n[tool.poetry.dependencies.ok]\nversion = "1"\n`;
    expect(pyprojectNames(text)).toEqual(["ok", ...LEGACY]);
  });

  it("ignores values it does not need: arrays of tables, nested inline tables, literals, numbers, dates", () => {
    const text = `
title = 'literal \\ string'
when = 2026-10-08T00:00:00Z
count = 3
ratio = 1.5
flag = true
nested = { a = { b = [1, 2, [3]] }, c = "}" }
raw = '''
multi ] line [ literal
'''
[[tool.something]]
dependencies = ["not-this"]
[project]
dependencies = ["kept"]
`;
    expect(pyprojectNames(text)).toEqual(["kept", ...LEGACY]);
  });

  it("handles CRLF line endings, quoted dotted keys and multi-line basic strings with continuations", () => {
    const text = [
      "[project]",
      'description = """\\',
      '   trimmed by the line-ending backslash ""quoted"""""',
      '"site"."key" = 1',
      "dependencies = [ # trailing comment",
      '  "a",',
      '  "b"  ,  ]',
      "",
    ].join("\r\n");
    expect(pyprojectNames(text)).toEqual(["a", "b", ...LEGACY]);
  });

  it("is empty for a pyproject with no dependencies or dynamic dependencies", () => {
    expect(pyprojectNames("")).toEqual(LEGACY);
    expect(pyprojectNames(`[project]\nname = "a"\ndynamic = ["dependencies"]\n`)).toEqual(LEGACY);
  });

  it.each([
    ["an unterminated array", `[project]\ndependencies = [\n "flask",\n`],
    ["an unterminated string", `[project]\ndependencies = ["flask]\n`],
    ["a bad table header", `[project\ndependencies = ["flask"]\n`],
    ["a line without a value", `[project]\ndependencies\n`],
    ["a non-string dependency", `[project]\ndependencies = [1]\n`],
    ["dependencies that are not an array", `[project]\ndependencies = "flask"\n`],
    ["trailing garbage after a value", `[project]\ndependencies = ["flask"] x\n`],
    ["an unknown escape", `[project]\ndependencies = ["fl\\qask"]\n`],
    ["a duplicate key", `[project]\ndependencies = ["a"]\ndependencies = ["b"]\n`],
    ["optional-dependencies that is not a table", `[project]\noptional-dependencies = ["a"]\n`],
  ])("throws on %s", (_label, text) => {
    expect(() => pyprojectNames(text)).toThrow();
  });
});

describe("packageJsonNames", () => {
  it("reads dependencies, devDependencies and optionalDependencies, not peer", () => {
    const text = JSON.stringify({
      name: "app",
      dependencies: { express: "^4", "@scope/lib": "1.2.3" },
      devDependencies: { vitest: "^3", typescript: "latest" },
      optionalDependencies: { fsevents: "*" },
      peerDependencies: { react: "^19" },
    });
    expect(packageJsonNames(text)).toEqual(["express", "@scope/lib", "vitest", "typescript", "fsevents"]);
  });

  it("follows npm: aliases to the real package and skips non-registry specs", () => {
    const text = JSON.stringify({
      dependencies: {
        alias: "npm:real-pkg@^2",
        scopedAlias: "npm:@org/real@1",
        bareAlias: "npm:plain",
        local: "file:../local",
        linked: "link:../linked",
        ws: "workspace:*",
        gh: "github:org/repo",
        short: "org/repo#main",
        git: "git+https://github.com/org/repo.git",
        tarball: "https://example.com/pkg.tgz",
        notString: 3,
      },
    });
    expect(packageJsonNames(text)).toEqual(["real-pkg", "@org/real", "plain"]);
  });

  it("ignores missing or malformed dependency fields", () => {
    expect(packageJsonNames(JSON.stringify({ dependencies: ["a"], devDependencies: null }))).toEqual([]);
  });

  it("throws on invalid JSON or a non-object document", () => {
    expect(() => packageJsonNames("{")).toThrow();
    expect(() => packageJsonNames("[]")).toThrow();
  });
});

describe("own project names", () => {
  it("reads [project].name and [tool.poetry].name from pyproject.toml", () => {
    expect(pyprojectOwnNames(`[project]\nname = "My_Proj"\n[tool.poetry]\nname = "other"\n`)).toEqual([
      "My_Proj",
      "other",
    ]);
    expect(pyprojectOwnNames(`[project]\ndependencies = []\n`)).toEqual([]);
  });
  it("reads package.json's own name", () => {
    expect(packageJsonOwnNames(JSON.stringify({ name: "app", dependencies: {} }))).toEqual(["app"]);
    expect(packageJsonOwnNames(JSON.stringify({ dependencies: {} }))).toEqual([]);
    expect(packageJsonOwnNames(JSON.stringify({ name: 7 }))).toEqual([]);
  });
});
