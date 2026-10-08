import { loadSlackConfig } from "../../config/providers.js";
import { SlackChatProvider } from "./slack.js";
import type { ChatProviderRegistry } from "./types.js";

export * from "./types.js";

/** One provider per configured chat service; empty when Slack is not configured. */
export function buildChatProviders(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ChatProviderRegistry {
  const slack = loadSlackConfig(env);
  return slack ? { slack: new SlackChatProvider(slack, fetchImpl) } : {};
}
