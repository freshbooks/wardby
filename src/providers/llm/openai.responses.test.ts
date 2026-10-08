import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { encode as encodeO200kBase } from "gpt-tokenizer/encoding/o200k_base";
import { OpenAiLlmProvider, estimateTokens } from "./openai.js";
import { shippedCatalog } from "./catalog.js";
import type { CatalogEntry } from "./catalog-types.js";
import type { LlmRequest, LlmStreamEvent } from "./types.js";

interface CapturedCall {
  params: Record<string, unknown>;
  options: { signal?: AbortSignal } | undefined;
}

/** A fake client whose `responses.create` records its arguments and streams `events`. */
function fakeResponsesClient(events: unknown[]): { client: OpenAI; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client = {
    responses: {
      create: async (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        calls.push({ params, options });
        async function* generator() {
          for (const event of events) yield event;
        }
        return generator();
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

function completed(usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: "response.completed", response: { status: "completed", usage, ...extra } };
}

const SMALL_USAGE = { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } };

async function collect(llm: OpenAiLlmProvider, req: LlmRequest, signal?: AbortSignal): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of llm.stream(req, signal)) events.push(event);
  return events;
}

const miniEntry = (): CatalogEntry => shippedCatalog().require("gpt-4o-mini");
/** A reasoning-model entry: accepts low/high only, priced at round numbers for easy assertions. */
const reasoningEntry = (): CatalogEntry => ({
  ...miniEntry(),
  modelId: "reasoner",
  efforts: ["low", "high"],
  inputPerMTok: 2,
  cachedInputPerMTok: 0.5,
  cacheWritePerMTok: 3,
  outputPerMTok: 10,
});

describe("OpenAiLlmProvider (Responses API) stream parsing", () => {
  it("maps output_text deltas to text events and completes with stopReason stop", async () => {
    const { client } = fakeResponsesClient([
      { type: "response.created", response: {} },
      { type: "response.output_text.delta", delta: "hel" },
      { type: "response.output_text.delta", delta: "lo" },
      completed(SMALL_USAGE),
    ]);
    const events = await collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [] });

    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", delta: "hel" },
      { type: "text", delta: "lo" },
    ]);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.stopReason).toBe("stop");
      expect(done.usage.inputTokens).toBe(3);
      expect(done.usage.outputTokens).toBe(2);
    }
  });

  it("emits one tool_call per completed function_call item and stopReason tool_calls", async () => {
    const { client } = fakeResponsesClient([
      {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", delta: '{"city":' },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"Boston"}',
        },
      },
      completed(SMALL_USAGE),
    ]);
    const events = await collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [] });

    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_1", name: "get_weather", argsJson: '{"city":"Boston"}' },
    ]);
    const done = events.at(-1);
    expect(done?.type === "done" && done.stopReason).toBe("tool_calls");
  });

  it("emits two tool calls from one turn in order", async () => {
    const { client } = fakeResponsesClient([
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_a", name: "toolA", arguments: "{}" },
      },
      { type: "response.output_item.done", item: { type: "message", content: [] } },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_b", name: "toolB", arguments: '{"x":1}' },
      },
      completed(SMALL_USAGE),
    ]);
    const events = await collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [] });

    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_a", name: "toolA", argsJson: "{}" },
      { type: "tool_call", id: "call_b", name: "toolB", argsJson: '{"x":1}' },
    ]);
  });

  it("maps response.incomplete for max_output_tokens to stopReason length, with usage", async () => {
    const { client } = fakeResponsesClient([
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: SMALL_USAGE },
      },
    ]);
    const events = await collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [] });

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.stopReason).toBe("length");
      expect(done.usage.outputTokens).toBe(2);
    }
  });

  it("reports cached and cache-write tokens and prices reasoning tokens at the output rate", async () => {
    const usage = {
      input_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 400_000, cache_write_tokens: 200_000 },
      // output_tokens already includes the reasoning tokens.
      output_tokens: 1_000_000,
      output_tokens_details: { reasoning_tokens: 900_000 },
    };
    const { client } = fakeResponsesClient([completed(usage)]);
    const llm = new OpenAiLlmProvider("k", client).withEntry(reasoningEntry());
    const events = await collect(llm, { model: "reasoner", messages: [] });

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.usage).toMatchObject({
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        cacheWriteTokens: 200_000,
        outputTokens: 1_000_000,
      });
      // fresh 0.6M × $2 + cached 0.4M × $0.5 + write 0.2M × $3 + output 1M × $10
      expect(done.usage.costUsd).toBeCloseTo(1.2 + 0.2 + 0.6 + 10, 9);
    }
  });

  it("leaves cacheWriteTokens unset when the API reports none (or zero)", async () => {
    const usage = {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
      output_tokens: 1,
    };
    const { client } = fakeResponsesClient([completed(usage)]);
    const events = await collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [] });

    const done = events.at(-1);
    expect(done?.type === "done" && done.usage.cachedInputTokens).toBe(4);
    expect(done?.type === "done" && "cacheWriteTokens" in done.usage).toBe(false);
  });

  it("throws the API message on response.failed", async () => {
    const { client } = fakeResponsesClient([
      { type: "response.output_text.delta", delta: "x" },
      {
        type: "response.failed",
        response: { status: "failed", error: { code: "server_error", message: "boom upstream" } },
      },
    ]);
    await expect(collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [] })).rejects.toThrow(
      /boom upstream/,
    );
  });

  it("throws the API message on an error event", async () => {
    const { client } = fakeResponsesClient([{ type: "error", code: "rate_limit", message: "slow down", param: null }]);
    await expect(collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [] })).rejects.toThrow(
      /slow down/,
    );
  });
});

describe("OpenAiLlmProvider (Responses API) request mapping", () => {
  it("always sends stream:true and store:false, maps maxTokens, never sends stop sequences", async () => {
    const { client, calls } = fakeResponsesClient([completed(SMALL_USAGE)]);
    await collect(new OpenAiLlmProvider("k", client), {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 123,
      stopSequences: ["END"],
    });

    const params = calls[0].params;
    expect(params).toMatchObject({ model: "gpt-4o-mini", stream: true, store: false, max_output_tokens: 123 });
    expect(params).not.toHaveProperty("stop");
    expect(JSON.stringify(params)).not.toContain("END");
  });

  it("raises maxTokens below the API's minimum of 16 to 16", async () => {
    const { client, calls } = fakeResponsesClient([completed(SMALL_USAGE)]);
    await collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [], maxTokens: 5 });

    expect(calls[0].params.max_output_tokens).toBe(16);
  });

  it("passes the abort signal to create", async () => {
    const { client, calls } = fakeResponsesClient([completed(SMALL_USAGE)]);
    const controller = new AbortController();
    await collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [] }, controller.signal);

    expect(calls[0].options?.signal).toBe(controller.signal);
  });

  it("maps a tool round trip to input items and tools to the Responses function shape", async () => {
    const { client, calls } = fakeResponsesClient([completed(SMALL_USAGE)]);
    await collect(new OpenAiLlmProvider("k", client), {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "add 1 and 2, then 3 and 4" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "add", argsJson: '{"a":1,"b":2}' },
            { id: "call_2", name: "add", argsJson: '{"a":3,"b":4}' },
          ],
        },
        { role: "tool", content: "3", toolCallId: "call_1", name: "add" },
        { role: "tool", content: "7", toolCallId: "call_2", name: "add" },
        { role: "assistant", content: "Let me check.", toolCalls: [{ id: "call_3", name: "add", argsJson: "{}" }] },
        { role: "tool", content: "0", toolCallId: "call_3", name: "add" },
        { role: "assistant", content: "3 and 7" },
      ],
      tools: [{ name: "add", description: "Adds", parameters: { type: "object", properties: {} } }],
    });

    const params = calls[0].params;
    expect(params.input).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "add 1 and 2, then 3 and 4" },
      { type: "function_call", call_id: "call_1", name: "add", arguments: '{"a":1,"b":2}' },
      { type: "function_call", call_id: "call_2", name: "add", arguments: '{"a":3,"b":4}' },
      { type: "function_call_output", call_id: "call_1", output: "3" },
      { type: "function_call_output", call_id: "call_2", output: "7" },
      { role: "assistant", content: "Let me check." },
      { type: "function_call", call_id: "call_3", name: "add", arguments: "{}" },
      { type: "function_call_output", call_id: "call_3", output: "0" },
      { role: "assistant", content: "3 and 7" },
    ]);
    expect(params.tools).toEqual([
      {
        type: "function",
        name: "add",
        description: "Adds",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ]);
  });

  it("sends reasoning.effort only when the catalog entry lists that effort", async () => {
    const { client, calls } = fakeResponsesClient([completed(SMALL_USAGE)]);
    const llm = new OpenAiLlmProvider("k", client).withEntry(reasoningEntry());

    await collect(llm, { model: "reasoner", messages: [], effort: "high" });
    await collect(llm, { model: "reasoner", messages: [], effort: "max" });
    await collect(llm, { model: "reasoner", messages: [] });

    expect(calls[0].params.reasoning).toEqual({ effort: "high" });
    expect(calls[1].params).not.toHaveProperty("reasoning");
    expect(calls[2].params).not.toHaveProperty("reasoning");
  });

  it("drops effort for a model with no efforts", async () => {
    const { client, calls } = fakeResponsesClient([completed(SMALL_USAGE)]);
    await collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [], effort: "low" });

    expect(calls[0].params).not.toHaveProperty("reasoning");
  });

  it("sends temperature only when the catalog entry has no efforts", async () => {
    const { client, calls } = fakeResponsesClient([completed(SMALL_USAGE)]);
    await collect(new OpenAiLlmProvider("k", client), { model: "gpt-4o-mini", messages: [], temperature: 0.2 });
    await collect(new OpenAiLlmProvider("k", client).withEntry(reasoningEntry()), {
      model: "reasoner",
      messages: [],
      temperature: 0.2,
    });

    expect(calls[0].params.temperature).toBe(0.2);
    expect(calls[1].params).not.toHaveProperty("temperature");
  });
});

describe("estimateTokens serializes the Responses tool shape", () => {
  it("counts exactly the tool payload stream() sends", () => {
    const tools = [{ name: "add", description: "Adds", parameters: { type: "object", properties: {} } }];
    const responsesShape = [
      {
        type: "function",
        name: "add",
        description: "Adds",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ];
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(estimateTokens("gpt-4o-mini", messages, tools) - estimateTokens("gpt-4o-mini", messages)).toBe(
      encodeO200kBase(JSON.stringify(responsesShape)).length,
    );
  });
});
