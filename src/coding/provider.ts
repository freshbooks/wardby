import { currentModelCatalog } from "../providers/llm/catalog-store.js";
import type { ModelCatalog } from "../providers/llm/catalog.js";
import type { ModelProvider } from "../providers/llm/catalog-types.js";

export const CODING_PROVIDERS = ["codex", "claude-code"] as const;

export type CodingProvider = (typeof CODING_PROVIDERS)[number];

/** Which coding provider runs a model provider's models; Bedrock models are never coding models. */
export function codingProviderForModelProvider(provider: ModelProvider): CodingProvider | undefined {
  if (provider === "openai") return "codex";
  if (provider === "anthropic") return "claude-code";
  return undefined;
}

export function codingProviderSupportsModel(
  provider: CodingProvider,
  model: string,
  catalog: ModelCatalog = currentModelCatalog(),
): boolean {
  const entry = catalog.get(model);
  return entry !== undefined && codingProviderForModelProvider(entry.provider) === provider;
}

export function assertCodingProvider(provider: string): asserts provider is CodingProvider {
  if (!CODING_PROVIDERS.includes(provider as CodingProvider)) {
    throw new Error(`Unsupported coding provider "${provider}".`);
  }
}

export function assertCodingProviderModel(provider: string, model: string): asserts provider is CodingProvider {
  assertCodingProvider(provider);
  if (!codingProviderSupportsModel(provider, model)) {
    throw new Error(`Model "${model}" is not supported by coding provider "${provider}".`);
  }
}
