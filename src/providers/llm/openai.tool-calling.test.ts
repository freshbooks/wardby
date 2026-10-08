import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { OpenAiLlmProvider, estimateTokens, openaiCredentialsPresent } from "./openai.js";
import { shippedCatalog } from "./catalog.js";
import type { LlmMessage, LlmStreamEvent, LlmToolDef } from "./types.js";

function fakeOpenAiClient(events: unknown[]): OpenAI {
  return {
    responses: {
      create: async () => {
        async function* generator() {
          for (const event of events) yield event;
        }
        return generator();
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAiLlmProvider tool calls (Responses API)", () => {
  it("emits a tool_call from the completed function_call item, ignoring argument fragments", async () => {
    // The Responses API streams arguments as response.function_call_arguments.delta
    // fragments, but output_item.done carries the complete call — that is the
    // only event the adapter turns into a tool_call.
    const events = [
      {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", delta: '{"city":' },
      { type: "response.function_call_arguments.delta", delta: '"Boston"}' },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Boston"}' },
      },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } },
      },
    ];
    const llm = new OpenAiLlmProvider("fake-key", fakeOpenAiClient(events));

    const out: LlmStreamEvent[] = [];
    for await (const event of llm.stream({ model: "gpt-4o-mini", messages: [{ role: "user", content: "weather?" }] })) {
      out.push(event);
    }

    expect(out.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_1", name: "get_weather", argsJson: '{"city":"Boston"}' },
    ]);
  });

  it("still emits text/done for a text-only stream", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2 } } },
    ];
    const llm = new OpenAiLlmProvider("fake-key", fakeOpenAiClient(events));

    const out: LlmStreamEvent[] = [];
    for await (const event of llm.stream({ model: "gpt-4o-mini", messages: [] })) {
      out.push(event);
    }

    expect(out.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual(["hel", "lo"]);
    expect(out.filter((e) => e.type === "tool_call")).toHaveLength(0);
    const done = out.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.usage.inputTokens).toBe(3);
      expect(done.usage.outputTokens).toBe(2);
      expect(done.usage.cachedInputTokens).toBe(0);
    }
  });
});

describe("estimateTokens with tools", () => {
  const messages: LlmMessage[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is the weather in Boston?" },
  ];
  const tools: LlmToolDef[] = [
    {
      name: "getWeather",
      description: "Gets the current weather for a named city, returning temperature and conditions.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "The city name, e.g. Boston" },
          units: { type: "string", enum: ["fahrenheit", "celsius"] },
        },
        required: ["city"],
      },
    },
  ];

  it("counts tool schema tokens — the estimate with tools attached must exceed the messages-only estimate", () => {
    // This is the regression test for the real bug: the pre-flight
    // estimate used to ignore `tools` entirely, so an agent with a tool
    // roster large enough to matter could pass the turn-1 refuse gate
    // (cumulative spend still zero) even though the real request — which
    // does include the serialized tool schemas — would cost meaningfully
    // more than the messages alone.
    const withoutTools = estimateTokens("gpt-4o-mini", messages);
    const withTools = estimateTokens("gpt-4o-mini", messages, tools);

    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it("scales with the size of the tool roster", () => {
    const oneTool = estimateTokens("gpt-4o-mini", messages, tools);
    const twoTools = estimateTokens("gpt-4o-mini", messages, [
      ...tools,
      {
        name: "getForecast",
        description: "Gets a multi-day forecast for a named city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" }, days: { type: "number" } },
          required: ["city", "days"],
        },
      },
    ]);

    expect(twoTools).toBeGreaterThan(oneTool);
  });

  it("is a no-op for an empty tool array (matches the omitted-tools estimate)", () => {
    expect(estimateTokens("gpt-4o-mini", messages, [])).toBe(estimateTokens("gpt-4o-mini", messages));
  });
});

describe("OpenAiLlmProvider.withEntry", () => {
  it("withEntry keeps the injected client and prices from the pinned entry", async () => {
    const streamed = [
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.completed", response: { usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
    ];
    const pinned = new OpenAiLlmProvider("fake-key", fakeOpenAiClient(streamed)).withEntry({
      ...shippedCatalog().require("gpt-4o-mini"),
      inputPerMTok: 7,
    });

    const events: LlmStreamEvent[] = [];
    for await (const event of pinned.stream({ model: "gpt-4o-mini", messages: [] })) {
      events.push(event);
    }

    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.usage.costUsd).toBeCloseTo(7, 9);
    expect(() => pinned.priceUsd("gpt-4o", { inputTokens: 1, outputTokens: 0 })).toThrow(/reason: not_in_catalog/);
  });
});

describe("openaiCredentialsPresent", () => {
  it("is true only when OPENAI_API_KEY is set in the given environment", () => {
    expect(openaiCredentialsPresent({ OPENAI_API_KEY: "sk-x" })).toBe(true);
    expect(openaiCredentialsPresent({})).toBe(false);
  });
});
