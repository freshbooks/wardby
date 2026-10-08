import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { FakeChatProvider } from "../providers/chat/fake.js";
import { installWorkflowEventRecorder, startNotifications } from "./notifications.js";
import { emitWorkflowEvent, setWorkflowEventSink } from "./workflow-events.js";

afterEach(() => {
  setWorkflowEventSink(null);
  vi.useRealTimers();
});

function fakeDb(): { db: PrismaClient; findUnique: ReturnType<typeof vi.fn> } {
  const findUnique = vi.fn(async () => null);
  const db = { workflowEvent: { findUnique } } as unknown as PrismaClient;
  return { db, findUnique };
}

describe("installWorkflowEventRecorder", () => {
  it("is a no-op with no chat provider configured: emitWorkflowEvent stays a no-op", async () => {
    const { db, findUnique } = fakeDb();
    installWorkflowEventRecorder(db, {});
    await emitWorkflowEvent({
      dedupeKey: "test:2",
      payload: { kind: "issue_picked_up", agentName: "a", trigger: "t" },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("installs the recorder sink when a chat provider is configured", async () => {
    const { db, findUnique } = fakeDb();
    installWorkflowEventRecorder(db, { slack: new FakeChatProvider() });
    await emitWorkflowEvent({
      dedupeKey: "test:3",
      payload: { kind: "issue_picked_up", agentName: "a", trigger: "t" },
    });
    expect(findUnique).toHaveBeenCalled();
  });
});

describe("startNotifications", () => {
  it("does nothing with no chat provider configured: returns a handle, and emitWorkflowEvent stays a no-op", async () => {
    const { db, findUnique } = fakeDb();

    const handle = await startNotifications({ db, chat: {} });
    expect(handle.stop).toBeTypeOf("function");
    handle.stop();

    await emitWorkflowEvent({
      dedupeKey: "test:1",
      payload: { kind: "issue_picked_up", agentName: "a", trigger: "t" },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("installs the recorder, logs identity, and returns a handle whose stop() clears the dispatch interval", async () => {
    vi.useFakeTimers();
    const { db } = fakeDb();
    const slack = new FakeChatProvider();
    const authTestSpy = vi.spyOn(slack, "authTest");

    const handle = await startNotifications({ db, chat: { slack }, holder: "test-holder" });

    expect(authTestSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    handle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs the auth check failure but still returns a handle (never fatal)", async () => {
    vi.useFakeTimers();
    const { db } = fakeDb();
    const slack = new FakeChatProvider();
    const { ChatError } = await import("../providers/chat/types.js");
    slack.failNext("authTest", new ChatError("auth_failed", "invalid_auth"));

    const handle = await startNotifications({ db, chat: { slack } });
    expect(handle.stop).toBeTypeOf("function");
    handle.stop();
  });
});
