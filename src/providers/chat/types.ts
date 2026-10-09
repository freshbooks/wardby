/**
 * Host-neutral chat surface for outbound workflow notifications. Slack is
 * the first (and only) implementation (./slack.ts). wardby only ever posts
 * or updates messages here — it never reads channel history or listens for
 * events.
 */
export const CHAT_PROVIDERS = ["slack"] as const;
export type ChatProviderName = (typeof CHAT_PROVIDERS)[number];

export type ChatErrorCode =
  | "rate_limited" // retryAfterMs set
  | "channel_unreachable" // channel_not_found, not_in_channel, is_archived
  | "auth_failed" // invalid_auth, token_revoked, account_inactive, missing_scope, not_authed
  | "message_not_found" // chat.update on a deleted parent
  | "transient"; // network, 5xx, anything else

export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    readonly slackError: string,
    readonly retryAfterMs?: number,
  ) {
    super(`chat_error:${code}:${slackError}`);
    this.name = "ChatError";
  }
}

export interface ChatMessage {
  text: string;
  blocks?: unknown[];
  username?: string;
  iconEmoji?: string;
}

export interface ChatProvider {
  readonly name: ChatProviderName;
  postMessage(
    channelId: string,
    msg: ChatMessage,
    opts?: { threadTs?: string; broadcast?: boolean },
  ): Promise<{ ts: string }>;
  updateMessage(channelId: string, ts: string, msg: ChatMessage): Promise<void>;
  /** null when the bot cannot see the channel; throws ChatError("auth_failed") on missing scope. */
  channelInfo(channel: string): Promise<{ id: string; name: string; isPrivate: boolean } | null>;
  authTest(): Promise<{ team: string; botUserId: string }>;
}

export type ChatProviderRegistry = Partial<Record<ChatProviderName, ChatProvider>>;
