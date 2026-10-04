// Summarizes the request shapes in a recorded Codex fixture (src/providers/
// coding-proxy/fixtures/codex-<version>-responses-requests.json) and diffs two
// of them, so a Codex bump's review shows exactly which request keys, input
// item and content types, tool types and pinned values are new or gone: the
// things the coding proxy's OpenAI Responses allowlist decides on.

type Json = Record<string, unknown>;

export interface FixtureEntry {
  scenario: string;
  body: Json;
}

/** Category -> sorted distinct values. */
export type RequestShape = Record<string, string[]>;

const CATEGORIES = [
  "top-level keys",
  "input item types",
  "input item keys",
  "message roles",
  "message phases",
  "content part types",
  "content part keys",
  "tool types",
  "tool keys",
  "tools",
  "tool_choice values",
  "parallel_tool_calls values",
  "include values",
  "reasoning",
  "text",
  "service_tier values",
  "client_metadata keys",
  "x-codex-turn-metadata keys",
] as const;

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((entry): entry is Json => !!entry && typeof entry === "object") : [];
}

/** A string as is; anything else (a malformed recording) as JSON. */
function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function requestShape(fixture: readonly FixtureEntry[]): RequestShape {
  const shape = new Map<string, Set<string>>(CATEGORIES.map((category) => [category, new Set<string>()]));
  const add = (category: (typeof CATEGORIES)[number], value: string) => shape.get(category)!.add(value);
  const keys = (value: Json) => Object.keys(value).sort().join(",");

  const addTools = (tools: unknown, where: string, namespace?: string) => {
    for (const tool of records(tools)) {
      const type = text(tool.type);
      add("tool types", `${where}${namespace ? " namespace" : ""}: ${type}`);
      add("tool keys", `${type}: ${keys(tool)}`);
      add("tools", `${type}:${namespace ? `${namespace}.` : ""}${text(tool.name ?? "")}`);
      if (tool.tools !== undefined) addTools(tool.tools, where, text(tool.name));
    }
  };
  const addContent = (container: string, value: unknown) => {
    for (const part of records(value)) {
      add("content part types", `${container}: ${text(part.type)}`);
      add("content part keys", `${text(part.type)}: ${keys(part)}`);
    }
  };

  for (const { body } of fixture) {
    for (const key of Object.keys(body)) add("top-level keys", key);
    if (body.tools !== undefined) addTools(body.tools, "top-level tools");
    if (body.tool_choice !== undefined) add("tool_choice values", JSON.stringify(body.tool_choice));
    if (body.parallel_tool_calls !== undefined) {
      add("parallel_tool_calls values", JSON.stringify(body.parallel_tool_calls));
    }
    if (body.service_tier !== undefined) add("service_tier values", JSON.stringify(body.service_tier));
    for (const entry of Array.isArray(body.include) ? body.include : []) add("include values", text(entry));
    if (body.reasoning && typeof body.reasoning === "object") {
      for (const [key, value] of Object.entries(body.reasoning)) add("reasoning", `${key}=${JSON.stringify(value)}`);
    }
    if (body.text && typeof body.text === "object") {
      for (const [key, value] of Object.entries(body.text as Json)) {
        if (key === "format" && value && typeof value === "object") {
          const format = value as Json;
          add("text", `format.type=${JSON.stringify(format.type)} (${keys(format)})`);
        } else {
          add("text", `${key}=${JSON.stringify(value)}`);
        }
      }
    }
    const metadata = (body.client_metadata ?? {}) as Json;
    for (const key of Object.keys(metadata)) add("client_metadata keys", key);
    const turn = metadata["x-codex-turn-metadata"];
    if (typeof turn === "string") {
      try {
        for (const key of Object.keys(JSON.parse(turn) as Json)) add("x-codex-turn-metadata keys", key);
      } catch {
        add("x-codex-turn-metadata keys", "(not JSON)");
      }
    }
    if (typeof body.input === "string") add("input item types", "(string input)");
    for (const item of records(body.input)) {
      const type = item.type === undefined ? "(untyped message)" : text(item.type);
      add("input item types", type);
      add("input item keys", `${type}: ${keys(item)}`);
      if (typeof item.role === "string") add("message roles", `${type}: ${item.role}`);
      if (item.phase !== undefined) add("message phases", `${type}: ${JSON.stringify(item.phase)}`);
      if (type === "additional_tools") addTools(item.tools, "additional_tools");
      if (Array.isArray(item.content)) addContent(`${type}.content`, item.content);
      if (Array.isArray(item.summary)) addContent(`${type}.summary`, item.summary);
      if (Array.isArray(item.output)) addContent(`${type}.output`, item.output);
      else if (typeof item.output === "string") add("content part types", `${type}.output: (string)`);
    }
  }
  return Object.fromEntries([...shape].map(([category, values]) => [category, [...values].sort()]));
}

export interface ShapeChange {
  category: string;
  added: string[];
  removed: string[];
}

export function diffRequestShapes(previous: RequestShape, next: RequestShape): ShapeChange[] {
  const changes: ShapeChange[] = [];
  for (const category of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const before = new Set(previous[category] ?? []);
    const after = new Set(next[category] ?? []);
    const added = [...after].filter((value) => !before.has(value));
    const removed = [...before].filter((value) => !after.has(value));
    if (added.length || removed.length) changes.push({ category, added, removed });
  }
  return changes;
}

export function formatShapeDiff(changes: readonly ShapeChange[], previousLabel: string, nextLabel: string): string {
  const lines = [`Codex request-shape diff: ${previousLabel} -> ${nextLabel}`];
  if (changes.length === 0) {
    lines.push("  (no request-shape changes)");
    return lines.join("\n");
  }
  for (const { category, added, removed } of changes) {
    lines.push(`  ${category}:`);
    for (const value of added) lines.push(`    + ${value}`);
    for (const value of removed) lines.push(`    - ${value}`);
  }
  return lines.join("\n");
}
