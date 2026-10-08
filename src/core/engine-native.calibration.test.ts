import { describe, expect, it, vi } from "vitest";
import type { LlmProvider, LlmStreamEvent, LlmUsage } from "../providers/index.js";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./logger.js", () => ({ logger: { child: () => log } }));

const { NativeEngine } = await import("./engine-native.js");

/** One-turn LLM whose pre-flight estimate is `estimate` tokens and whose final usage is `usage`. */
function oneTurnLlm(estimate: number, usage: LlmUsage): LlmProvider {
  const events: LlmStreamEvent[] = [
    { type: "text", delta: "ok" },
    { type: "done", stopReason: "stop", usage },
  ];
  return {
    async *stream() {
      for (const event of events) yield event;
    },
    async countTokens() {
      return estimate;
    },
    priceUsd() {
      return 0;
    },
  };
}

async function runWith(llm: LlmProvider) {
  return new NativeEngine().run({
    agent: { systemPrompt: "sys", model: "m", budgetUsd: 1000, maxTurns: 10 },
    tools: [],
    providers: { llm },
    runSandboxTool: vi.fn(async () => "{}"),
  });
}

const driftWarnings = () =>
  log.warn.mock.calls.filter(([, msg]) => typeof msg === "string" && msg.includes("token calibration drift"));

describe("NativeEngine token calibration", () => {
  it("counts cache-write tokens as prompt tokens, so a cache-write turn is not flagged as overestimated", async () => {
    log.warn.mockClear();
    // The estimate covers the whole prompt (1000); the provider reports 100
    // plain input tokens plus 900 written to the cache.
    await runWith(oneTurnLlm(1000, { inputTokens: 100, cacheWriteTokens: 900, outputTokens: 1, costUsd: 0 }));
    expect(driftWarnings()).toEqual([]);
  });

  it("still warns when the estimate genuinely diverges from the prompt size", async () => {
    log.warn.mockClear();
    await runWith(oneTurnLlm(1000, { inputTokens: 100, outputTokens: 1, costUsd: 0 }));
    expect(driftWarnings()).toHaveLength(1);
  });
});
