/**
 * OpenAI adapter for the `LlmProvider` seam. The `openai` npm package is used
 * only inside this file; core never imports it.
 *
 * It speaks the Responses API, not Chat Completions: Chat Completions rejects
 * any request carrying tools on gpt-5.6-* and gpt-6-*, while Responses takes
 * tools on every OpenAI model and reasoning effort on the reasoning ones.
 *
 * Mapping notes (what the Responses API cannot carry, and why that's fine):
 * - `stopSequences` is dropped — Responses has no stop parameter ("Unknown
 *   parameter" on every model). No caller sets it today.
 * - `LlmMessage.name` is dropped — Responses has no per-message name. The
 *   engine sets it only on tool results, where `call_id` already correlates.
 * - `store: false` is always sent — Responses stores every response by
 *   default, and wardby replays the whole conversation itself each turn.
 * - Reasoning items are not replayed between turns: with `store: false` the
 *   next turn starts without the previous turn's hidden reasoning, only the
 *   visible text and function_call/function_call_output items. That costs
 *   some reasoning continuity, not correctness.
 * - Reasoning tokens never stream as deltas, so the engine's mid-stream budget
 *   estimate (driven by text deltas) can't see them. They arrive inside
 *   `output_tokens` on the final usage and are charged there, at the output
 *   rate, which is how OpenAI bills them; the per-turn reservation and
 *   post-turn accounting still bound spend.
 */

import OpenAI from "openai";
import { encode as encodeCl100kBase } from "gpt-tokenizer/encoding/cl100k_base";
import { encode as encodeO200kBase } from "gpt-tokenizer/encoding/o200k_base";
import type { LlmMessage, LlmRequest, LlmStreamEvent, LlmToolDef, LlmUsage } from "./types.js";
import { computeCost } from "./pricing-core.js";
import { currentLookup, pinnedLookup, type CatalogLookup } from "./catalog-lookup.js";
import type { CatalogEntry } from "./catalog-types.js";
import type { CatalogLlmAdapter } from "./routing.js";

/** Whether the OpenAI adapter has credentials to run (used by the router's enable-by-credential wiring). */
export function openaiCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

// Per-message token overhead from OpenAI's public chat-format guidance
// (role framing + a name field costs a few tokens beyond the raw content).
// This is a pre-flight *estimate* for the budget guardrail, not an exact
// match to server-side billing — the real count comes back in `usage` on
// the `done` event.
const TOKENS_PER_MESSAGE = 3;
const TOKENS_PER_NAME = 1;
const TOKENS_PRIMING_REPLY = 3;

// gpt-tokenizer's package default is cl100k_base, but every gpt-4o-and-later
// model (all of Phase 1's roster) actually uses o200k_base — using the
// wrong table skews the pre-flight token count, which is the budget
// guardrail's input. The encoding lives on the catalog entry, so a model
// can't be run without also declaring which tokenizer counts it.
function encodeForModel(model: string, text: string, lookup: CatalogLookup): number[] {
  const { encoding } = lookup(model);
  return encoding === "o200k_base" ? encodeO200kBase(text) : encodeCl100kBase(text);
}

/**
 * Same shape sent to the API in `stream()` — kept as one function so the
 * estimate can never drift from what's actually serialized. `strict: false`
 * because wardby's tool schemas aren't written to strict mode's rules (every
 * property required, additionalProperties false), and Responses defaults
 * strict on.
 */
function toOpenAiTools(tools: LlmToolDef[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

// Responses rejects max_output_tokens below 16 with a 400 ("Expected a value
// >= 16"). Raising a smaller cap to 16 costs at most a few output tokens;
// failing the call outright would cost the whole turn.
const MIN_MAX_OUTPUT_TOKENS = 16;

/** One `LlmMessage` becomes zero or more Responses input items, in order. */
function toResponsesInput(messages: LlmMessage[]): OpenAI.Responses.ResponseInputItem[] {
  const input: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.toolCallId ?? "", output: m.content });
      continue;
    }
    const toolCalls = m.role === "assistant" ? (m.toolCalls ?? []) : [];
    // An assistant turn that only made tool calls has empty text; an empty
    // assistant message item adds nothing, so omit it.
    if (!(m.content === "" && toolCalls.length > 0)) {
      input.push({ role: m.role, content: m.content });
    }
    for (const tc of toolCalls) {
      input.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.argsJson });
    }
  }
  return input;
}

/** The final usage block on response.completed / response.incomplete. */
interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  // cache_write_tokens is reported by the API but not yet in the SDK's types.
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

// Fixed: this used to count message tokens only. When a request carries
// `tools`, OpenAI also tokenizes the serialized tool JSON schemas into the
// prompt — measured live at a 44-52% under-count for a small tool roster,
// which is what let a turn-1 pre-flight refuse (budget.ts, cumulative
// spend still zero) admit a run whose real input cost already exceeded
// budget. Counting `JSON.stringify` of the same payload `stream()` sends
// is still an *approximation* (not OpenAI's undocumented exact tool-schema
// tokenization), not a byte-for-byte match — calibration logging
// (budget.ts's checkTokenCalibration) is what surfaces any remaining drift.
export function estimateTokens(
  model: string,
  messages: LlmMessage[],
  tools?: LlmToolDef[],
  lookup: CatalogLookup = currentLookup,
): number {
  let total = TOKENS_PRIMING_REPLY;
  for (const message of messages) {
    total += TOKENS_PER_MESSAGE;
    total += encodeForModel(model, message.content, lookup).length;
    total += encodeForModel(model, message.role, lookup).length;
    if (message.name) {
      total += encodeForModel(model, message.name, lookup).length + TOKENS_PER_NAME;
    }
  }
  if (tools && tools.length > 0) {
    total += encodeForModel(model, JSON.stringify(toOpenAiTools(tools)), lookup).length;
  }
  return total;
}

export class OpenAiLlmProvider implements CatalogLlmAdapter {
  private readonly client: OpenAI;

  /**
   * `client` is an injection point for tests and withEntry — a real adapter
   * never passes it. `lookup` is a parameter property so it is set before the
   * early return below.
   */
  constructor(
    apiKey: string = process.env.OPENAI_API_KEY ?? "",
    client?: OpenAI,
    private readonly lookup: CatalogLookup = currentLookup,
  ) {
    if (client) {
      this.client = client;
      return;
    }
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set — required by the OpenAI LlmProvider adapter.");
    }
    this.client = new OpenAI({ apiKey });
  }

  withEntry(entry: CatalogEntry): OpenAiLlmProvider {
    return new OpenAiLlmProvider("", this.client, pinnedLookup(entry));
  }

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const entry = this.lookup(req.model);
    // Effort is sent only at a level the catalog says the model accepts and
    // dropped otherwise (the LlmRequest.effort contract). Temperature only
    // goes to non-reasoning models: reasoning models reject it ("not
    // supported with this model").
    const sendEffort = req.effort !== undefined && entry.efforts.includes(req.effort);
    const sendTemperature = req.temperature !== undefined && entry.efforts.length === 0;
    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: req.model,
      input: toResponsesInput(req.messages),
      stream: true,
      store: false,
      ...(req.tools ? { tools: toOpenAiTools(req.tools) } : {}),
      ...(req.maxTokens !== undefined ? { max_output_tokens: Math.max(req.maxTokens, MIN_MAX_OUTPUT_TOKENS) } : {}),
      // The SDK's ReasoningEffort type predates xhigh/max; the API accepts them.
      ...(sendEffort ? { reasoning: { effort: req.effort as OpenAI.ReasoningEffort } } : {}),
      ...(sendTemperature ? { temperature: req.temperature } : {}),
    };
    const stream = await this.client.responses.create(params, { signal });

    let sawToolCall = false;
    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          yield { type: "text", delta: event.delta };
          break;
        case "response.output_item.done":
          // Arguments also stream as function_call_arguments.delta fragments,
          // but the done item carries the complete call — emit from that.
          if (event.item.type === "function_call") {
            sawToolCall = true;
            yield { type: "tool_call", id: event.item.call_id, name: event.item.name, argsJson: event.item.arguments };
          }
          break;
        case "response.completed":
        case "response.incomplete": {
          const stopReason = sawToolCall
            ? "tool_calls"
            : event.response.incomplete_details?.reason === "max_output_tokens"
              ? "length"
              : "stop";
          yield { type: "done", stopReason, usage: this.toUsage(req.model, event.response.usage) };
          break;
        }
        case "response.failed":
          throw new Error(`OpenAI response failed: ${event.response.error?.message ?? "no error message"}`);
        case "error":
          throw new Error(`OpenAI stream error: ${event.message}`);
        default:
          break;
      }
    }
  }

  private toUsage(model: string, raw: ResponsesUsage | null | undefined): LlmUsage {
    const inputTokens = raw?.input_tokens ?? 0;
    // output_tokens already includes reasoning tokens.
    const outputTokens = raw?.output_tokens ?? 0;
    const cachedInputTokens = raw?.input_tokens_details?.cached_tokens ?? 0;
    const cacheWrite = raw?.input_tokens_details?.cache_write_tokens;
    const tokens = {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      ...(cacheWrite !== undefined && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    };
    return { ...tokens, costUsd: this.priceUsd(model, tokens) };
  }

  async countTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): Promise<number> {
    return estimateTokens(model, messages, tools, this.lookup);
  }

  priceUsd(
    model: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
    },
  ): number {
    return computeCost(this.lookup(model), usage);
  }
}
