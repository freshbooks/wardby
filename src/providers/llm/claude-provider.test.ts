import { describe, it, expect } from "vitest";
import { ClaudeLlmProvider, type ClaudeMessagesClient } from "./claude-provider.js";
import type { LlmStreamEvent } from "./types.js";
import { pinnedLookup, type CatalogLookup } from "./catalog-lookup.js";
import type { CatalogEntry } from "./catalog-types.js";

function fakeClient(events: any[], onParams?: (params: any) => void): ClaudeMessagesClient {
  return {
    messages: {
      stream: (params: any) => {
        onParams?.(params);
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  };
}

const KNOWN_MODEL = "fake-claude-model";
const FAKE_ENTRY: CatalogEntry = {
  provider: "anthropic",
  modelId: KNOWN_MODEL,
  encoding: "o200k_base",
  inputPerMTok: 2,
  outputPerMTok: 10,
  cachedInputPerMTok: 0.2,
  cacheWritePerMTok: 2.5,
  efforts: ["low", "medium", "high"],
  thinkingMode: "adaptive",
};

function fakeLookup(): CatalogLookup {
  return pinnedLookup(FAKE_ENTRY);
}

async function collect(it: AsyncIterable<LlmStreamEvent>) {
  const o: LlmStreamEvent[] = [];
  for await (const e of it) o.push(e);
  return o;
}

describe("ClaudeLlmProvider", () => {
  it("streams text and a done event with a priced usage, including cache accounting", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const p = new ClaudeLlmProvider(fakeClient(events), fakeLookup());
    const out = await collect(p.stream({ model: KNOWN_MODEL, messages: [{ role: "user", content: "hi" }] }));
    const done = out.find((e) => e.type === "done") as any;
    // inputTokens = input_tokens + cache_read (mapClaudeStream's contract, see claude-messages.ts)
    expect(done.usage.inputTokens).toBe(14);
    expect(done.usage.cachedInputTokens).toBe(4);
    expect(done.usage.cacheWriteTokens).toBe(2);
    expect(done.usage.costUsd).toBeGreaterThan(0);
  });

  it("defaults max_tokens well above a short report's worth of output", async () => {
    let sentParams: any;
    const events = [
      {
        type: "message_start",
        message: {
          usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const p = new ClaudeLlmProvider(
      fakeClient(events, (params) => {
        sentParams = params;
      }),
      fakeLookup(),
    );
    await collect(p.stream({ model: KNOWN_MODEL, messages: [{ role: "user", content: "hi" }] }));
    expect(sentParams.max_tokens).toBeGreaterThanOrEqual(16000);
  });

  describe("effort", () => {
    const events = [
      {
        type: "message_start",
        message: {
          usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    async function sentParamsFor(req: Parameters<ClaudeLlmProvider["stream"]>[0]) {
      let sent: any;
      const p = new ClaudeLlmProvider(
        fakeClient(events, (params) => {
          sent = params;
        }),
        fakeLookup(),
      );
      await collect(p.stream(req));
      return sent;
    }

    it("sends output_config.effort when the model accepts the level", async () => {
      const sent = await sentParamsFor({
        model: KNOWN_MODEL,
        messages: [{ role: "user", content: "hi" }],
        effort: "low",
      });
      expect(sent.output_config).toEqual({ effort: "low" });
    });

    it("never sends a level the model does not accept", async () => {
      const sent = await sentParamsFor({
        model: KNOWN_MODEL,
        messages: [{ role: "user", content: "hi" }],
        effort: "max",
      });
      expect(sent).not.toHaveProperty("output_config");
    });

    it("sends exactly today's body when effort is unset", async () => {
      const sent = await sentParamsFor({ model: KNOWN_MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(JSON.stringify(sent)).toBe(
        JSON.stringify({
          model: KNOWN_MODEL,
          messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
          max_tokens: 16000,
        }),
      );
    });
  });

  it("countTokens is offline, inflates over the raw estimate, counts tools, and fails closed on an unknown model", async () => {
    const p = new ClaudeLlmProvider(fakeClient([]), fakeLookup());
    const withoutTools = await p.countTokens(KNOWN_MODEL, [{ role: "user", content: "hello world" }]);
    const withTools = await p.countTokens(
      KNOWN_MODEL,
      [{ role: "user", content: "hello world" }],
      [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
    );
    expect(withoutTools).toBeGreaterThan(0);
    expect(withTools).toBeGreaterThan(withoutTools);
    await expect(p.countTokens("unknown-model", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /reason: not_in_catalog/,
    );
  });

  it("priceUsd prices from the injected catalog entry", () => {
    const p = new ClaudeLlmProvider(fakeClient([]), fakeLookup());
    const cost = p.priceUsd(KNOWN_MODEL, { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(2, 9); // 1M fresh input tokens @ $2/MTok
  });

  it("withEntry prices from the pinned entry and refuses any other model", () => {
    const p = new ClaudeLlmProvider(fakeClient([]), fakeLookup()).withEntry({ ...FAKE_ENTRY, inputPerMTok: 7 });
    expect(p.priceUsd(KNOWN_MODEL, { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(7, 9);
    expect(() => p.priceUsd("other-model", { inputTokens: 1, outputTokens: 0 })).toThrow(/reason: not_in_catalog/);
  });
});
