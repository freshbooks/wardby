import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_TRUNCATION,
  normalizeRecordedRequests,
  type RecordedCodexRequest,
} from "../coding-worker/codex-recorder.test-support.js";
import { diffRequestShapes, formatShapeDiff, requestShape, type FixtureEntry } from "./codex-request-shape.js";

const body = (change: Record<string, unknown> = {}) => ({
  model: "m",
  input: [
    { type: "message", id: "msg_1", role: "user", content: [{ type: "input_text", text: "hi" }] },
    {
      type: "additional_tools",
      role: "developer",
      tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: {} }] }],
    },
  ],
  include: ["reasoning.encrypted_content"],
  reasoning: { effort: "medium" },
  text: { verbosity: "low", format: { type: "json_schema", name: "s", schema: {}, strict: true } },
  client_metadata: { session_id: "s", "x-codex-turn-metadata": '{"turn_id":"t"}' },
  stream: true,
  ...change,
});

describe("Codex request-shape diff", () => {
  it("reports no change between a fixture and itself", async () => {
    const pinned = (
      JSON.parse(await readFile(new URL("../coding-worker/package.json", import.meta.url), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies["@openai/codex-sdk"];
    const fixture = JSON.parse(
      await readFile(
        new URL(`../providers/coding-proxy/fixtures/codex-${pinned}-responses-requests.json`, import.meta.url),
        "utf8",
      ),
    ) as FixtureEntry[];
    const shape = requestShape(fixture);
    expect(shape["input item types"]).toContain("additional_tools");
    expect(diffRequestShapes(shape, requestShape(fixture))).toEqual([]);
    expect(formatShapeDiff([], "a", "b")).toContain("(no request-shape changes)");
  });

  it("names new top-level keys, item and tool types, and pinned values", () => {
    const before = requestShape([{ scenario: "a", body: body() }]);
    const after = requestShape([
      {
        scenario: "a",
        body: body({
          service_tier: "priority",
          include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
          reasoning: { effort: "ultra" },
          input: [
            { type: "compaction", encrypted_content: "x" },
            {
              type: "additional_tools",
              role: "developer",
              tools: [{ type: "namespace", name: "web", tools: [{ type: "web_search" }] }],
            },
          ],
        }),
      },
    ]);
    const changes = Object.fromEntries(diffRequestShapes(before, after).map((change) => [change.category, change]));
    expect(changes["top-level keys"].added).toEqual(["service_tier"]);
    expect(changes["service_tier values"].added).toEqual(['"priority"']);
    expect(changes["include values"].added).toEqual(["web_search_call.action.sources"]);
    expect(changes["reasoning"]).toEqual({
      category: "reasoning",
      added: ['effort="ultra"'],
      removed: ['effort="medium"'],
    });
    expect(changes["input item types"].added).toEqual(["compaction"]);
    expect(changes["input item types"].removed).toEqual(["message"]);
    expect(changes["tool types"].added).toEqual(["additional_tools namespace: web_search"]);
    const text = formatShapeDiff(diffRequestShapes(before, after), "codex 1", "codex 2");
    expect(text).toContain("+ service_tier");
    expect(text).toContain("- message");
  });
});

describe("Codex recording normalization", () => {
  it("pins paths, ids, timestamps and long texts without changing the request shape", () => {
    const long = "x".repeat(450);
    const turn = JSON.stringify({
      thread_id: "01a0df85-19a3-7cf3-b5a2-30b1e685d2d0",
      turn_started_at_unix_ms: 1790456487539,
    });
    const recorded: RecordedCodexRequest[] = [
      {
        scenario: "s",
        body: {
          input: [
            {
              type: "message",
              id: "msg_01a0df85-19c1-7843-b715-94364a968edb",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "<cwd>/private/var/folders/T/wardby-codex-record-1/workspace</cwd><current_date>2026-10-03</current_date>",
                },
                { type: "input_text", text: long },
              ],
            },
          ],
          prompt_cache_key: "01a0df85-19a3-7cf3-b5a2-30b1e685d2d0",
          client_metadata: { thread_id: "01a0df85-19a3-7cf3-b5a2-30b1e685d2d0", "x-codex-turn-metadata": turn },
        },
      },
    ];
    const [{ body }] = normalizeRecordedRequests(recorded, [
      "/var/folders/T/wardby-codex-record-1",
      "/private/var/folders/T/wardby-codex-record-1",
    ]);
    const content = (body.input as Array<{ id: string; content: Array<{ text: string }> }>)[0];
    expect(content.content[0].text).toBe(
      "<cwd>/tmp/codex-capture/workspace</cwd><current_date>2026-01-01</current_date>",
    );
    expect(content.content[1].text).toBe("x".repeat(400) + FIXTURE_TRUNCATION);
    expect(body.prompt_cache_key).toBe("00000000-0000-7000-8000-000000000002");
    expect(content.id).toBe("msg_00000000-0000-7000-8000-000000000001");
    expect(Object.keys(body.client_metadata as object)).toEqual(["thread_id", "x-codex-turn-metadata"]);
    expect(JSON.parse((body.client_metadata as Record<string, string>)["x-codex-turn-metadata"])).toEqual({
      thread_id: "00000000-0000-7000-8000-000000000002",
      turn_started_at_unix_ms: 1790000000000,
    });
    expect(requestShape([{ scenario: "s", body }])).toEqual(requestShape(recorded));
  });
});
