import { describe, expect, it } from "vitest";
import type { CodingTaskInput } from "../coding/protocol.js";
import { deriveRegistryToken } from "../coding/registry/token.js";
import { workerDebugTracer } from "../coding-worker/debug-trace.js";
import { parseWorkerDiagnosticLine } from "../providers/jobs/docker.js";
import { runClaudeCodingWorker, type ClaudeQueryFactory, type ClaudeQueryOptions } from "./driver.js";

const CAPABILITY = `rrp_${"C".repeat(43)}`;
const REGISTRY_TOKEN = deriveRegistryToken(CAPABILITY);
const ANTHROPIC_KEY = `sk-ant-api03-${"k".repeat(40)}`;

const input: CodingTaskInput = {
  schemaVersion: 1,
  runId: "run_claude_trace",
  repository: "your-org/your-repo",
  baseRef: "main",
  headRef: "wardby/run-run_claude_trace",
  task: "Fix the failing test.",
  model: "claude-sonnet-5",
  budgetUsd: 1,
  deadlineAt: "2026-09-07T13:00:00.000Z",
};

const RESULT = JSON.stringify({
  schemaVersion: 1,
  runId: input.runId,
  outcome: "changes_ready",
  summary: "Fixed it.",
  tests: [],
});

/** What the Agent SDK streams for one shell command: the tool_use carries the command, the tool_result its output. */
const MESSAGES = [
  { type: "system", subtype: "init", mcp_servers: [{ name: "wardby_tools", status: "connected" }] },
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "mcp__wardby_tools__run_command",
          input: { command: `curl -H "Authorization: Bearer ${CAPABILITY}" -H "x-api-key: ${ANTHROPIC_KEY}" proxy` },
        },
      ],
    },
  },
  {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: true,
          content: `npm ERR! //proxy/registry/npm/:_authToken=${REGISTRY_TOKEN}`,
        },
      ],
    },
  },
  { type: "result", subtype: "success", result: RESULT, duration_ms: 1234, usage: { input_tokens: 10 } },
];

function stream(messages: unknown[], throwAfter?: Error): ClaudeQueryFactory {
  return () =>
    (async function* () {
      for (const message of messages) yield message as never;
      if (throwAfter) throw throwAfter;
    })();
}

function traced(debugTrace: boolean, extra: Partial<CodingTaskInput> = {}) {
  const lines: string[] = [];
  const runInput = { ...input, ...(debugTrace ? { debugTrace: true } : {}), ...extra };
  const trace = workerDebugTracer(runInput, CAPABILITY, (line) => lines.push(line));
  const parsed = () => lines.map((line) => (JSON.parse(line) as { debugTrace: Record<string, unknown> }).debugTrace);
  return { runInput, trace, lines, parsed };
}

describe("Claude Code debug trace", () => {
  it("writes every SDK message, in order, under the Codex trace shape", async () => {
    const { runInput, trace, parsed } = traced(true);
    await runClaudeCodingWorker({
      input: runInput,
      proxyBaseUrl: "http://proxy:8787",
      capability: CAPABILITY,
      signal: new AbortController().signal,
      createQuery: stream(MESSAGES),
      trace,
    });
    const records = parsed();
    expect(records.map((r) => r.kind)).toEqual(["message", "message", "message", "message"]);
    expect(records.map((r) => (r.data as { type: string }).type)).toEqual(["system", "assistant", "user", "result"]);
    for (const record of records) {
      expect(record).toMatchObject({ runId: input.runId, at: expect.any(Number) });
    }
    expect(records[1].data).toMatchObject({
      message: { content: [{ type: "tool_use", name: "mcp__wardby_tools__run_command" }] },
    });
    expect(records[2].data).toMatchObject({ message: { content: [{ type: "tool_result", is_error: true }] } });
    expect(records[3].data).toMatchObject({ duration_ms: 1234, usage: { input_tokens: 10 } });
  });

  it("redacts the capability, registry token, bearer tokens and API keys from commands and output", async () => {
    const { runInput, trace, lines } = traced(true);
    await runClaudeCodingWorker({
      input: runInput,
      proxyBaseUrl: "http://proxy:8787",
      capability: CAPABILITY,
      signal: new AbortController().signal,
      createQuery: stream(MESSAGES),
      trace,
    });
    const text = lines.join("");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("curl");
    for (const secret of [CAPABILITY, REGISTRY_TOKEN.slice(4), ANTHROPIC_KEY.slice(7)]) {
      expect(text).not.toContain(secret);
    }
  });

  it("caps each line and the run, honouring debugTraceMaxMb", async () => {
    const huge = { type: "user", message: { content: [{ type: "tool_result", content: "y".repeat(40_000) }] } };
    const { runInput, trace, lines, parsed } = traced(true, { debugTraceMaxMb: 1 });
    await expect(
      runClaudeCodingWorker({
        input: runInput,
        proxyBaseUrl: "http://proxy:8787",
        capability: CAPABILITY,
        signal: new AbortController().signal,
        createQuery: stream(Array.from({ length: 100 }, () => huge)),
        trace,
      }),
    ).rejects.toThrow("coding_output_missing");
    for (const line of lines) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(16 * 1024);
    expect(parsed()[0]).toMatchObject({ truncated: true });
    expect(parsed().at(-1)).toMatchObject({ kind: "limit_reached", data: { maxTotalBytes: 1024 * 1024 } });
  });

  it("writes a stream failure in full, while the run error stays a fixed code", async () => {
    const { runInput, trace, parsed } = traced(true);
    const failure = new Error("socket hang up", { cause: new Error(`upstream said ${CAPABILITY}`) });
    await expect(
      runClaudeCodingWorker({
        input: runInput,
        proxyBaseUrl: "http://proxy:8787",
        capability: CAPABILITY,
        signal: new AbortController().signal,
        createQuery: stream(MESSAGES.slice(0, 2), failure),
        trace,
      }),
    ).rejects.toThrow(/^coding_stream_failed$/);
    const error = parsed().at(-1)!;
    expect(error).toMatchObject({
      kind: "stream_error",
      data: { name: "Error", message: "socket hang up", cause: { message: "upstream said [REDACTED]" } },
    });
  });

  it("passes Claude Code's stderr to the trace only on a traced run", async () => {
    let captured: ClaudeQueryOptions | undefined;
    const capturing: ClaudeQueryFactory = (options) => {
      captured = options;
      options.stderr?.(`spawn failed, key ${CAPABILITY}`);
      return stream(MESSAGES)(options);
    };
    const on = traced(true);
    await runClaudeCodingWorker({
      input: on.runInput,
      proxyBaseUrl: "http://proxy:8787",
      capability: CAPABILITY,
      signal: new AbortController().signal,
      createQuery: capturing,
      trace: on.trace,
    });
    expect(on.parsed()[0]).toMatchObject({ kind: "sdk_stderr", data: "spawn failed, key [REDACTED]" });

    const off = traced(false);
    expect(off.trace).toBeUndefined();
    await runClaudeCodingWorker({
      input: off.runInput,
      proxyBaseUrl: "http://proxy:8787",
      capability: CAPABILITY,
      signal: new AbortController().signal,
      createQuery: capturing,
      trace: off.trace,
    });
    expect(captured).not.toHaveProperty("stderr");
    expect(off.lines).toEqual([]);
  });

  it("never produces a line the launchers read as a worker diagnostic", async () => {
    const { runInput, trace, lines } = traced(true);
    await expect(
      runClaudeCodingWorker({
        input: runInput,
        proxyBaseUrl: "http://proxy:8787",
        capability: CAPABILITY,
        signal: new AbortController().signal,
        createQuery: stream([{ type: "result", subtype: "error_during_execution", error: "worker_failed" }]),
        trace,
      }),
    ).rejects.toThrow("coding_turn_failed");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(parseWorkerDiagnosticLine(line.trim())).toBeUndefined();
  });
});
