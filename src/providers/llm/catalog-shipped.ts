/**
 * The model catalog wardby ships. Every entry is fully literal: rates are the
 * provider's own published numbers for that exact model, never derived from
 * another field (CLAUDE.md "LLM pricing tables — STRICT"). A deployment's
 * admins override or extend this with ModelCatalogEntry rows (set_model);
 * this file changes only with a wardby release, and SHIPPED_CATALOG_VERSION
 * must be bumped whenever any value here changes.
 *
 * Anthropic and Bedrock rates are the 5-minute cache-TTL numbers
 * (platform.claude.com/docs/en/about-claude/pricing): wardby only emits the
 * default 5-minute cache_control breakpoint. OpenAI's pre-GPT-5.6 models have
 * no distinct cache-write tier (a first-time prefix bills at the standard
 * input rate), so their cacheWritePerMTok is their own input rate, stated
 * literally.
 */
import type { CatalogEntry } from "./catalog-types.js";
import type { LlmEffort } from "./types.js";

export const SHIPPED_CATALOG_VERSION = "2026-10-08";

const ALL_EFFORTS: readonly LlmEffort[] = ["low", "medium", "high", "xhigh", "max"];

export const SHIPPED_CATALOG: readonly CatalogEntry[] = [
  // OpenAI
  {
    provider: "openai",
    modelId: "gpt-4o",
    encoding: "o200k_base",
    inputPerMTok: 2.5,
    outputPerMTok: 10.0,
    cachedInputPerMTok: 1.25,
    cacheWritePerMTok: 2.5,
    efforts: [],
    thinkingMode: "none",
  },
  {
    provider: "openai",
    modelId: "gpt-4o-mini",
    encoding: "o200k_base",
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cachedInputPerMTok: 0.075,
    cacheWritePerMTok: 0.15,
    efforts: [],
    thinkingMode: "none",
  },
  {
    provider: "openai",
    modelId: "gpt-4.1",
    encoding: "o200k_base",
    inputPerMTok: 2.0,
    outputPerMTok: 8.0,
    cachedInputPerMTok: 0.5,
    cacheWritePerMTok: 2.0,
    efforts: [],
    thinkingMode: "none",
  },
  {
    provider: "openai",
    modelId: "gpt-4.1-mini",
    encoding: "o200k_base",
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 0.4,
    efforts: [],
    thinkingMode: "none",
  },
  {
    provider: "openai",
    modelId: "gpt-4.1-nano",
    encoding: "o200k_base",
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    cachedInputPerMTok: 0.025,
    cacheWritePerMTok: 0.1,
    efforts: [],
    thinkingMode: "none",
  },
  {
    provider: "openai",
    modelId: "gpt-6-astra",
    encoding: "o200k_base",
    inputPerMTok: 10.0,
    outputPerMTok: 50.0,
    cachedInputPerMTok: 1.0,
    cacheWritePerMTok: 12.5,
    efforts: ALL_EFFORTS,
    thinkingMode: "none",
  },
  {
    provider: "openai",
    modelId: "gpt-5.6-sol",
    encoding: "o200k_base",
    inputPerMTok: 4.0,
    outputPerMTok: 20.0,
    cachedInputPerMTok: 0.4,
    cacheWritePerMTok: 5.0,
    efforts: ALL_EFFORTS,
    thinkingMode: "none",
  },
  {
    provider: "openai",
    modelId: "gpt-5.6-terra",
    encoding: "o200k_base",
    inputPerMTok: 2.0,
    outputPerMTok: 12.0,
    cachedInputPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    efforts: ALL_EFFORTS,
    thinkingMode: "none",
  },
  {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    encoding: "o200k_base",
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cachedInputPerMTok: 0.02,
    cacheWritePerMTok: 0.25,
    efforts: ALL_EFFORTS,
    thinkingMode: "none",
  },
  // Anthropic (direct API)
  {
    provider: "anthropic",
    modelId: "claude-opus-5",
    encoding: "o200k_base",
    inputPerMTok: 5,
    outputPerMTok: 25,
    cachedInputPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    efforts: ALL_EFFORTS,
    thinkingMode: "adaptive",
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    encoding: "o200k_base",
    inputPerMTok: 2,
    outputPerMTok: 10,
    cachedInputPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    efforts: ALL_EFFORTS,
    thinkingMode: "adaptive",
  },
  {
    provider: "anthropic",
    modelId: "claude-fable-5",
    encoding: "o200k_base",
    inputPerMTok: 10,
    outputPerMTok: 50,
    cachedInputPerMTok: 1,
    cacheWritePerMTok: 12.5,
    efforts: ALL_EFFORTS,
    thinkingMode: "adaptive",
  },
  // Haiku 4.5 rejects adaptive thinking and any effort level.
  {
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    encoding: "o200k_base",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    efforts: [],
    thinkingMode: "manual",
  },
  // Bedrock-Claude (`us.` cross-region inference profiles). Effort is never sent
  // through Bedrock (unconfirmed per model), and wardby sends Bedrock no thinking
  // parameter at all, so thinkingMode is inert here; "adaptive" by convention.
  {
    provider: "bedrock-claude",
    modelId: "us.anthropic.claude-sonnet-4-6",
    encoding: "o200k_base",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    efforts: [],
    thinkingMode: "adaptive",
  },
  {
    provider: "bedrock-claude",
    modelId: "us.anthropic.claude-opus-4-6-v1",
    encoding: "o200k_base",
    inputPerMTok: 5,
    outputPerMTok: 25,
    cachedInputPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    efforts: [],
    thinkingMode: "adaptive",
  },
  {
    provider: "bedrock-claude",
    modelId: "us.anthropic.claude-opus-4-8",
    encoding: "o200k_base",
    inputPerMTok: 5,
    outputPerMTok: 25,
    cachedInputPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    efforts: [],
    thinkingMode: "adaptive",
  },
  {
    provider: "bedrock-claude",
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    encoding: "o200k_base",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    efforts: [],
    thinkingMode: "adaptive",
  },
];
