import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG, SHIPPED_CATALOG_VERSION } from "./catalog-shipped.js";
import { getModelPricing, supportedModels as openaiModels } from "./pricing.js";
import { anthropicSupportedEfforts, anthropicSupportedModels, getAnthropicPricing } from "./pricing-anthropic.js";
import {
  bedrockClaudeSupportedEfforts,
  bedrockClaudeSupportedModels,
  getBedrockClaudePricing,
} from "./pricing-bedrock-claude.js";

const byProvider = (provider: string) => SHIPPED_CATALOG.filter((e) => e.provider === provider);

describe("shipped model catalog", () => {
  it("has a dated version", () => {
    expect(SHIPPED_CATALOG_VERSION).toBe("2026-10-03");
  });

  it("carries exactly the models of the three old tables, nothing more", () => {
    expect(
      byProvider("openai")
        .map((e) => e.modelId)
        .sort(),
    ).toEqual(openaiModels().sort());
    expect(
      byProvider("anthropic")
        .map((e) => e.modelId)
        .sort(),
    ).toEqual(anthropicSupportedModels().sort());
    expect(
      byProvider("bedrock-claude")
        .map((e) => e.modelId)
        .sort(),
    ).toEqual(bedrockClaudeSupportedModels().sort());
    expect(SHIPPED_CATALOG).toHaveLength(
      openaiModels().length + anthropicSupportedModels().length + bedrockClaudeSupportedModels().length,
    );
  });

  it.each(SHIPPED_CATALOG.map((e) => [e.provider, e.modelId, e] as const))(
    "%s %s keeps its old rates, encoding and efforts",
    (provider, modelId, entry) => {
      const old =
        provider === "openai"
          ? getModelPricing(modelId)
          : provider === "anthropic"
            ? getAnthropicPricing(modelId)
            : getBedrockClaudePricing(modelId);
      expect(entry.encoding).toBe(old.encoding);
      expect(entry.inputPerMTok).toBe(old.inputPerMTok);
      expect(entry.outputPerMTok).toBe(old.outputPerMTok);
      expect(entry.cachedInputPerMTok).toBe(old.cachedInputPerMTok);
      // OpenAI's five pre-5.6 models have no cache-write tier: computeCost already billed
      // their cache writes at the input rate, so the literal is their own input rate.
      expect(entry.cacheWritePerMTok).toBe(old.cacheWritePerMTok ?? old.inputPerMTok);
      const oldEfforts =
        provider === "anthropic"
          ? anthropicSupportedEfforts(modelId)
          : provider === "bedrock-claude"
            ? bedrockClaudeSupportedEfforts(modelId)
            : [];
      expect([...entry.efforts]).toEqual([...oldEfforts]);
    },
  );

  it("marks only Claude Haiku 4.5 (direct API) as manual thinking, matching the proxy's old set", () => {
    const manual = SHIPPED_CATALOG.filter((e) => e.thinkingMode === "manual").map((e) => e.modelId);
    expect(manual).toEqual(["claude-haiku-4-5"]);
    for (const e of byProvider("openai")) expect(e.thinkingMode).toBe("none");
  });

  it("sets every rate as a finite non-negative literal", () => {
    for (const e of SHIPPED_CATALOG) {
      for (const rate of [e.inputPerMTok, e.outputPerMTok, e.cachedInputPerMTok, e.cacheWritePerMTok]) {
        expect(Number.isFinite(rate) && rate >= 0).toBe(true);
      }
    }
  });

  it("has unique model ids across providers (routing is by model id)", () => {
    const ids = SHIPPED_CATALOG.map((e) => e.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
