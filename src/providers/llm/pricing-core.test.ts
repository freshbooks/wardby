import { describe, expect, it } from "vitest";
import { computeCost, type ModelPricing } from "./pricing-core.js";

// Constructed entries, not catalog models: these pin the cost arithmetic itself.
const WITH_CACHE_RATES: ModelPricing = {
  encoding: "o200k_base",
  inputPerMTok: 3,
  outputPerMTok: 15,
  cachedInputPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};
const WITHOUT_CACHE_RATES: ModelPricing = { encoding: "o200k_base", inputPerMTok: 0.15, outputPerMTok: 0.6 };

describe("computeCost", () => {
  it("prices fresh input and output at the base rates when no cache tokens are reported", () => {
    expect(computeCost(WITH_CACHE_RATES, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 9);
  });

  it("prices cache reads (split out of inputTokens) and cache writes (on top) at their own rates", () => {
    const cost = computeCost(WITH_CACHE_RATES, {
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      cacheWriteTokens: 200_000,
      outputTokens: 100_000,
    });
    // 600k fresh @ $3 = 1.8; 400k read @ $0.30 = 0.12; 200k write @ $3.75 = 0.75; 100k out @ $15 = 1.5
    expect(cost).toBeCloseTo(4.17, 9);
  });

  it("falls back to the full input rate for cache reads and writes when an entry has no cache rates (overestimate, never under)", () => {
    const cost = computeCost(WITHOUT_CACHE_RATES, {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      cacheWriteTokens: 200_000,
      outputTokens: 0,
    });
    // 500k fresh + 500k read + 200k write, all @ $0.15 = 0.18
    expect(cost).toBeCloseTo(0.18, 9);
    // Never below what the same tokens cost with real (lower) cache rates.
    const withRates = computeCost(
      { ...WITHOUT_CACHE_RATES, cachedInputPerMTok: 0.015, cacheWritePerMTok: 0.1875 },
      { inputTokens: 1_000_000, cachedInputTokens: 500_000, cacheWriteTokens: 200_000, outputTokens: 0 },
    );
    expect(withRates).toBeCloseTo(0.12, 9);
    expect(cost).toBeGreaterThan(withRates);
  });
});
