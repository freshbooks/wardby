/**
 * Thin contract test against the real OpenAI API. Skipped unless
 * OPENAI_API_KEY is set — never runs in offline CI.
 */

import { describe, expect, it } from "vitest";
import { OpenAiLlmProvider } from "./openai.js";
import type { LlmEffort, LlmMessage, LlmStreamEvent, LlmToolDef, LlmUsage } from "./types.js";

const apiKey = process.env.OPENAI_API_KEY;

const weatherTool: LlmToolDef = {
  name: "get_weather",
  description: "Returns the current weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

async function collect(
  llm: OpenAiLlmProvider,
  req: Parameters<OpenAiLlmProvider["stream"]>[0],
): Promise<{ text: string; toolCalls: Extract<LlmStreamEvent, { type: "tool_call" }>[]; usage: LlmUsage }> {
  let text = "";
  const toolCalls: Extract<LlmStreamEvent, { type: "tool_call" }>[] = [];
  let usage: LlmUsage | undefined;
  for await (const event of llm.stream(req)) {
    if (event.type === "text") text += event.delta;
    else if (event.type === "tool_call") toolCalls.push(event);
    else usage = event.usage;
  }
  if (!usage) throw new Error("stream ended without a done event");
  return { text, toolCalls, usage };
}

/** Full tool round trip: model calls get_weather, we replay the result, model answers. */
async function toolRoundTrip(model: string, effort?: LlmEffort): Promise<void> {
  const llm = new OpenAiLlmProvider(apiKey);
  const base = { model, maxTokens: 1024, tools: [weatherTool], ...(effort ? { effort } : {}) };
  const messages: LlmMessage[] = [
    { role: "system", content: "Be terse." },
    { role: "user", content: "What is the weather in Paris? Use the get_weather tool." },
  ];

  const first = await collect(llm, { ...base, messages });
  console.log(`[${model} effort=${effort ?? "none"}] turn 1 usage`, JSON.stringify(first.usage));
  expect(first.toolCalls).toHaveLength(1);
  const call = first.toolCalls[0];
  expect(call.name).toBe("get_weather");
  expect(JSON.parse(call.argsJson)).toMatchObject({ city: expect.stringMatching(/paris/i) });

  const second = await collect(llm, {
    ...base,
    messages: [
      ...messages,
      {
        role: "assistant",
        content: first.text,
        toolCalls: [{ id: call.id, name: call.name, argsJson: call.argsJson }],
      },
      { role: "tool", toolCallId: call.id, name: call.name, content: '{"tempC":18}' },
    ],
  });
  console.log(`[${model} effort=${effort ?? "none"}] turn 2 usage`, JSON.stringify(second.usage));
  expect(second.text).toMatch(/18/);
  expect(second.usage.inputTokens).toBeGreaterThan(0);
  expect(second.usage.costUsd).toBeGreaterThan(0);
}

describe.skipIf(!apiKey)("OpenAiLlmProvider (network)", () => {
  it("streams a real completion and reports usage with a positive cost", async () => {
    const llm = new OpenAiLlmProvider(apiKey);
    const events: LlmStreamEvent[] = [];
    for await (const event of llm.stream({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say hi in one word." }],
      maxTokens: 5,
    })) {
      events.push(event);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.usage.inputTokens).toBeGreaterThan(0);
      expect(done.usage.costUsd).toBeGreaterThan(0);
    }
  }, 30_000);

  it("reassembles a real tool call from a live streaming round trip", async () => {
    const llm = new OpenAiLlmProvider(apiKey);
    const events: LlmStreamEvent[] = [];
    for await (const event of llm.stream({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "What is 17 plus 25? Use the add tool." }],
      tools: [
        {
          name: "add",
          description: "Adds two numbers",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      ],
    })) {
      events.push(event);
    }

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "tool_call") {
      expect(toolCall.name).toBe("add");
      const args = JSON.parse(toolCall.argsJson);
      expect(args).toMatchObject({ a: 17, b: 25 });
    }
  }, 30_000);

  it("round-trips a tool call on gpt-4.1-nano", () => toolRoundTrip("gpt-4.1-nano"), 60_000);
  it("round-trips a tool call on gpt-5.6-luna (no effort)", () => toolRoundTrip("gpt-5.6-luna"), 60_000);
  it("round-trips a tool call on gpt-5.6-luna (effort low)", () => toolRoundTrip("gpt-5.6-luna", "low"), 60_000);
  it("round-trips a tool call on gpt-6-astra (effort low)", () => toolRoundTrip("gpt-6-astra", "low"), 60_000);

  it("reports coherent usage on a single turn", async () => {
    const { usage } = await collect(new OpenAiLlmProvider(apiKey), {
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "Say hi in one word." }],
      maxTokens: 256,
    });
    console.log("[gpt-4.1-nano] usage sanity", JSON.stringify(usage));
    expect(usage.inputTokens).toBeGreaterThanOrEqual(usage.cachedInputTokens ?? 0);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(usage.costUsd).toBeGreaterThan(0);
  }, 60_000);
});
