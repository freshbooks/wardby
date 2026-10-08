/**
 * Pure readers for a repository's declared dependencies, used by the
 * quickstart to offer them as local-builder's package allowlist:
 * `pyproject.toml`, `requirements*.txt` and `package.json`. Each returns bare
 * top-level names as written; repo-packages.ts validates, normalizes,
 * de-duplicates and caps them.
 *
 * pyproject.toml is read by a deliberately narrow TOML scanner (no new
 * dependency): it understands tables, arrays of tables, dotted and quoted
 * keys, all four string forms, arrays and inline tables, and treats every
 * other scalar (numbers, booleans, dates) as opaque. Anything it cannot scan
 * throws, and the caller skips the file with a warning.
 */

const PEP508_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;
const ARCHIVE = /\.(?:whl|tar\.gz|tgz|tar\.bz2|tar\.xz|zip)$/i;

/**
 * The project name of a PEP 508 requirement ("requests[socks]>=2; python_version<'4'"),
 * or null for anything that is not a plain registry requirement: a direct URL
 * reference (`name @ url`), a path, a URL, or an archive file.
 */
export function requirementName(spec: string): string | null {
  const value = spec.trim();
  if (ARCHIVE.test(value.split(/[\s;]/)[0])) return null;
  const match = value.match(PEP508_NAME);
  if (!match) return null;
  const rest = value.slice(match[1].length).trimStart();
  return rest === "" || /^[[(;<>=!~,]/.test(rest) ? match[1] : null;
}

/** Names from a pip requirements file; options (`-r`, `-c`, `-e`, `--…`), URLs and paths are skipped. */
export function requirementsNames(text: string): string[] {
  const names: string[] = [];
  // pip joins backslash continuations first, then drops comments.
  const logical = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const raw of logical) {
    const line = raw
      .replace(/(?:^|\s)#.*$/, "")
      .replace(/\s+--[A-Za-z].*$/, "")
      .trim();
    if (!line || line.startsWith("-")) continue;
    const name = requirementName(line);
    if (name) names.push(name);
  }
  return names;
}

const NPM_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Names from package.json's dependencies, devDependencies and
 * optionalDependencies (peer dependencies are the consumer's to install).
 * An `npm:` alias names the real package; file, link, workspace, git, GitHub
 * and URL specs are not registry packages and are skipped.
 */
export function packageJsonNames(text: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // The parser's message can quote the file; keep the note short.
    throw new Error("not valid JSON");
  }
  if (!isPlainObject(doc)) throw new Error("package.json is not a JSON object");
  const names: string[] = [];
  for (const field of NPM_DEPENDENCY_FIELDS) {
    const deps = doc[field];
    if (!isPlainObject(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue;
      const value = spec.trim();
      if (value.startsWith("npm:")) {
        const target = value.slice("npm:".length);
        const at = target.indexOf("@", 1);
        names.push(at > 0 ? target.slice(0, at) : target);
      } else if (!/[:/]/.test(value)) {
        names.push(name);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------- TOML scan

class Opaque {
  constructor(readonly raw: string) {}
}
class Table {
  readonly entries = new Map<string, Value>();
}
type Value = string | Opaque | Table | Value[];

class TomlScanError extends Error {}

const BARE_KEY = /^[A-Za-z0-9_-]+/;
const SCALAR = /^[^\s,\]}#[{="']+/;
const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

class Scanner {
  private pos = 0;
  readonly root = new Table();

  constructor(private readonly text: string) {}

  private fail(message: string): never {
    const line = this.text.slice(0, this.pos).split("\n").length;
    throw new TomlScanError(`line ${line}: ${message}`);
  }

  private peek(length = 1): string {
    return this.text.slice(this.pos, this.pos + length);
  }

  /** Spaces and tabs only. */
  private skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  private skipComment(): void {
    if (this.peek() !== "#") return;
    while (this.pos < this.text.length && this.peek() !== "\n") this.pos++;
  }

  /** Whitespace, newlines and comments (inside arrays and between statements). */
  private skipBlank(): void {
    for (;;) {
      const start = this.pos;
      while (/^[ \t\r\n]$/.test(this.peek())) this.pos++;
      this.skipComment();
      if (this.pos === start) return;
    }
  }

  private endOfLine(): void {
    this.skipSpaces();
    this.skipComment();
    if (this.peek() === "\r") this.pos++;
    if (this.pos < this.text.length && this.peek() !== "\n") this.fail("unexpected text after a value");
  }

  scan(): Table {
    let current = this.root;
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.text.length) return this.root;
      if (this.peek(2) === "[[") {
        this.pos += 2;
        const path = this.keyPath();
        if (this.peek(2) !== "]]") this.fail("expected ]]");
        this.pos += 2;
        const parent = this.tableAt(this.root, path.slice(0, -1));
        const last = path[path.length - 1];
        const existing = parent.entries.get(last);
        const list = existing === undefined ? [] : existing;
        if (!Array.isArray(list)) this.fail(`${last} is not an array of tables`);
        const table = new Table();
        list.push(table);
        parent.entries.set(last, list);
        current = table;
      } else if (this.peek() === "[") {
        this.pos++;
        const path = this.keyPath();
        if (this.peek() !== "]") this.fail("expected ]");
        this.pos++;
        current = this.tableAt(this.root, path);
      } else {
        this.assignment(current);
      }
      this.endOfLine();
    }
  }

  private assignment(table: Table): void {
    const path = this.keyPath();
    if (this.peek() !== "=") this.fail("expected =");
    this.pos++;
    this.skipSpaces();
    const value = this.value();
    const parent = this.tableAt(table, path.slice(0, -1));
    const last = path[path.length - 1];
    if (parent.entries.has(last)) this.fail(`duplicate key ${last}`);
    parent.entries.set(last, value);
  }

  /** The table at `path` under `table`, created as needed; an array of tables resolves to its last element. */
  private tableAt(table: Table, path: string[]): Table {
    let current = table;
    for (const key of path) {
      let next = current.entries.get(key);
      if (next === undefined) {
        next = new Table();
        current.entries.set(key, next);
      }
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!(next instanceof Table)) this.fail(`${key} is not a table`);
      current = next;
    }
    return current;
  }

  private keyPath(): string[] {
    const path: string[] = [];
    for (;;) {
      this.skipSpaces();
      path.push(this.key());
      this.skipSpaces();
      if (this.peek() !== ".") return path;
      this.pos++;
    }
  }

  private key(): string {
    if (this.peek() === '"') return this.basicString();
    if (this.peek() === "'") return this.literalString();
    const match = this.text.slice(this.pos).match(BARE_KEY);
    if (!match) this.fail("expected a key");
    this.pos += match[0].length;
    return match[0];
  }

  private value(): Value {
    if (this.peek(3) === '"""') return this.multilineBasicString();
    if (this.peek(3) === "'''") return this.multilineLiteralString();
    if (this.peek() === '"') return this.basicString();
    if (this.peek() === "'") return this.literalString();
    if (this.peek() === "[") return this.array();
    if (this.peek() === "{") return this.inlineTable();
    const match = this.text.slice(this.pos).match(SCALAR);
    if (!match) this.fail("expected a value");
    this.pos += match[0].length;
    let raw = match[0];
    // A local date-time may separate date and time with a space.
    const time = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? this.text.slice(this.pos).match(/^ \d{2}:[^\s,\]}#]*/) : null;
    if (time) {
      this.pos += time[0].length;
      raw += time[0];
    }
    return new Opaque(raw);
  }

  private escape(): string {
    const code = this.peek();
    this.pos++;
    if (code in ESCAPES) return ESCAPES[code];
    if (code === "u" || code === "U") {
      const length = code === "u" ? 4 : 8;
      const hex = this.text.slice(this.pos, this.pos + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) this.fail("bad unicode escape");
      this.pos += length;
      const point = Number.parseInt(hex, 16);
      if (point > 0x10ffff) this.fail("bad unicode escape");
      return String.fromCodePoint(point);
    }
    this.fail("bad escape");
  }

  private basicString(): string {
    this.pos++;
    let out = "";
    for (;;) {
      const char = this.peek();
      if (char === "" || char === "\n") this.fail("unterminated string");
      this.pos++;
      if (char === '"') return out;
      out += char === "\\" ? this.escape() : char;
    }
  }

  private literalString(): string {
    this.pos++;
    const end = this.text.indexOf("'", this.pos);
    const newline = this.text.indexOf("\n", this.pos);
    if (end < 0 || (newline >= 0 && newline < end)) this.fail("unterminated string");
    const out = this.text.slice(this.pos, end);
    this.pos = end + 1;
    return out;
  }

  private multilineBasicString(): string {
    this.pos += 3;
    if (this.peek() === "\n") this.pos++;
    else if (this.peek(2) === "\r\n") this.pos += 2;
    let out = "";
    for (;;) {
      if (this.pos >= this.text.length) this.fail("unterminated string");
      if (this.peek(3) === '"""') {
        // Up to two quotes may sit right before the closing delimiter.
        let extra = 0;
        while (extra < 2 && this.text[this.pos + 3 + extra] === '"') extra++;
        out += '"'.repeat(extra);
        this.pos += 3 + extra;
        return out;
      }
      const char = this.peek();
      this.pos++;
      if (char !== "\\") {
        out += char;
        continue;
      }
      // A line-ending backslash trims the newline and following whitespace.
      const rest = this.text.slice(this.pos).match(/^[ \t]*\r?\n[ \t\r\n]*/);
      if (rest) this.pos += rest[0].length;
      else out += this.escape();
    }
  }

  private multilineLiteralString(): string {
    this.pos += 3;
    if (this.peek() === "\n") this.pos++;
    else if (this.peek(2) === "\r\n") this.pos += 2;
    const end = this.text.indexOf("'''", this.pos);
    if (end < 0) this.fail("unterminated string");
    let close = end;
    while (close - end < 2 && this.text[close + 3] === "'") close++;
    const out = this.text.slice(this.pos, close);
    this.pos = close + 3;
    return out;
  }

  private array(): Value[] {
    this.pos++;
    const items: Value[] = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === "]") {
        this.pos++;
        return items;
      }
      items.push(this.value());
      this.skipBlank();
      if (this.peek() === ",") this.pos++;
      else if (this.peek() !== "]") this.fail("expected , or ] in an array");
    }
  }

  private inlineTable(): Table {
    this.pos++;
    const table = new Table();
    for (;;) {
      this.skipBlank();
      if (this.peek() === "}") {
        this.pos++;
        return table;
      }
      this.assignment(table);
      this.skipBlank();
      if (this.peek() === ",") this.pos++;
      else if (this.peek() !== "}") this.fail("expected , or } in an inline table");
    }
  }
}

function get(table: Value | undefined, ...path: string[]): Value | undefined {
  let current = table;
  for (const key of path) {
    if (!(current instanceof Table)) return undefined;
    current = current.entries.get(key);
  }
  return current;
}

function requirementList(value: Value | undefined, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TomlScanError(`${where} is not an array`);
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new TomlScanError(`${where} holds a non-string entry`);
    const name = requirementName(item);
    if (name) names.push(name);
  }
  return names;
}

const NON_REGISTRY = ["path", "git", "url", "file"];

/** A Poetry dependency value that comes from a registry (a version string, or a table/list without a path, git or url source). */
function poetryFromRegistry(value: Value): boolean {
  if (value instanceof Table) return !NON_REGISTRY.some((key) => value.entries.has(key));
  if (Array.isArray(value)) return value.some(poetryFromRegistry);
  return true;
}

function poetryNames(value: Value | undefined): string[] {
  if (!(value instanceof Table)) return [];
  const names: string[] = [];
  for (const [key, spec] of value.entries) {
    if (key.toLowerCase() === "python" || !poetryFromRegistry(spec)) continue;
    if (requirementName(key) === key) names.push(key);
  }
  return names;
}

/**
 * Names from pyproject.toml: `[project] dependencies`, every
 * `[project.optional-dependencies]` group, `[tool.poetry.dependencies]`
 * (except python), `[tool.poetry.group.*.dependencies]` and the legacy
 * `[tool.poetry.dev-dependencies]`. Throws when the file cannot be scanned or
 * one of those keys has an unexpected shape.
 */
export function pyprojectNames(text: string): string[] {
  const root = new Scanner(text).scan();
  const names = requirementList(get(root, "project", "dependencies"), "project.dependencies");
  const optional = get(root, "project", "optional-dependencies");
  if (optional !== undefined) {
    if (!(optional instanceof Table)) throw new TomlScanError("project.optional-dependencies is not a table");
    for (const [group, list] of optional.entries) {
      names.push(...requirementList(list, `project.optional-dependencies.${group}`));
    }
  }
  const poetry = get(root, "tool", "poetry");
  names.push(...poetryNames(get(poetry, "dependencies")));
  const groups = get(poetry, "group");
  if (groups instanceof Table) {
    for (const group of groups.entries.values()) names.push(...poetryNames(get(group, "dependencies")));
  }
  names.push(...poetryNames(get(poetry, "dev-dependencies")));
  return names;
}
