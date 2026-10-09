/**
 * In-memory ChatProvider for tests: records every post/update, serves
 * `channelInfo` from a settable map, and lets a test queue one error per
 * method to be thrown on its next call.
 */
import type { ChatError, ChatMessage, ChatProvider } from "./types.js";

export class FakeChatProvider implements ChatProvider {
  readonly name = "slack" as const;
  readonly posts: Array<{ channelId: string; ts: string; msg: ChatMessage; threadTs?: string; broadcast?: boolean }> =
    [];
  readonly updates: Array<{ channelId: string; ts: string; msg: ChatMessage }> = [];
  readonly channels = new Map<string, { id: string; name: string; isPrivate: boolean }>();

  private readonly queuedErrors: Record<"postMessage" | "updateMessage" | "channelInfo" | "authTest", ChatError[]> = {
    postMessage: [],
    updateMessage: [],
    channelInfo: [],
    authTest: [],
  };

  private nextTs = 1;

  failNext(method: "postMessage" | "updateMessage" | "channelInfo" | "authTest", err: ChatError): void {
    this.queuedErrors[method].push(err);
  }

  private consumeFailure(method: "postMessage" | "updateMessage" | "channelInfo" | "authTest"): void {
    const err = this.queuedErrors[method].shift();
    if (err) throw err;
  }

  async postMessage(
    channelId: string,
    msg: ChatMessage,
    opts: { threadTs?: string; broadcast?: boolean } = {},
  ): Promise<{ ts: string }> {
    this.consumeFailure("postMessage");
    const ts = `${this.nextTs++}.000`;
    this.posts.push({ channelId, ts, msg, threadTs: opts.threadTs, broadcast: opts.broadcast });
    return { ts };
  }

  async updateMessage(channelId: string, ts: string, msg: ChatMessage): Promise<void> {
    this.consumeFailure("updateMessage");
    this.updates.push({ channelId, ts, msg });
  }

  async channelInfo(channel: string): Promise<{ id: string; name: string; isPrivate: boolean } | null> {
    this.consumeFailure("channelInfo");
    return this.channels.get(channel) ?? null;
  }

  async authTest(): Promise<{ team: string; botUserId: string }> {
    this.consumeFailure("authTest");
    return { team: "fake", botUserId: "UFAKE" };
  }
}
