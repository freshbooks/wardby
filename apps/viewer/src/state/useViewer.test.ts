import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FramePayload, StreamFrame } from "../api/client";
import type { GraphSnapshot, ViewerEvent } from "../api/types";

const calls: string[] = [];
let handler: ((p: FramePayload) => void) | null = null;
const unlisten = vi.fn();

vi.mock("../api/client", () => ({
  isAppError: (e: unknown) => typeof e === "object" && e !== null && "kind" in e && "message" in e,
  onFrame: vi.fn(async (cb: (p: FramePayload) => void) => {
    calls.push("onFrame");
    handler = cb;
    return unlisten;
  }),
  connect: vi.fn(async () => void calls.push("connect")),
  disconnect: vi.fn(async () => void calls.push("disconnect")),
  fetchGraph: vi.fn(async () => {
    calls.push("fetchGraph");
    return snapshot();
  }),
}));

import * as client from "../api/client";
import { useViewer } from "./useViewer";

const URL_ = "https://w.example";

function snapshot(): GraphSnapshot {
  return {
    generatedAt: "2026-10-02T00:00:00.000Z",
    since: "2026-10-01T23:00:00.000Z",
    limit: 500,
    truncated: false,
    runs: [],
    spend: { todayUsd: 0, groups: [] },
  };
}

const send = (frame: StreamFrame) => act(() => handler!({ server: URL_, frame }));
const runEvent = (runId: string): ViewerEvent =>
  ({
    kind: "run",
    runId,
    agentId: "a",
    status: "running",
    turns: 1,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    finishedAt: null,
    parentRunId: null,
  }) as ViewerEvent;
const settle = () => act(async () => {});
const fetches = () => calls.filter((c) => c === "fetchGraph").length;

beforeEach(() => {
  calls.length = 0;
  handler = null;
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("useViewer", () => {
  it("opens the stream before the first graph fetch", async () => {
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(calls.indexOf("connect")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("connect")).toBeLessThan(calls.indexOf("fetchGraph"));
    expect(fetches()).toBe(1);
  });

  it("does not fetch twice when hello arrives before connect resolves", async () => {
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    await send({ type: "hello", connected: true });
    await settle();
    expect(fetches()).toBe(1);
  });

  it("refetches on resync and tracks live status", async () => {
    const { result } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    await send({ type: "status", connected: true });
    expect(result.current.model.live).toBe(true);
    await send({ type: "resync" });
    await settle();
    expect(fetches()).toBe(2);
    await send({ type: "reconnecting", attempt: 1, delay_ms: 100 });
    expect(result.current.model.live).toBe(false);
    expect(result.current.reconnecting).toBe(true);
  });

  it("refetches once for three unknown-run events within 750 ms", async () => {
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(fetches()).toBe(1);
    await send({ type: "event", kind: "run", data: runEvent("r1") });
    await send({ type: "event", kind: "run", data: runEvent("r2") });
    await send({ type: "event", kind: "run", data: runEvent("r3") });
    expect(fetches()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(fetches()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetches()).toBe(2);
  });

  it("exposes needsSignIn and forbidden from an ended frame", async () => {
    const { result } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    await send({ type: "ended", error: { kind: "not_signed_in", message: "sign in" } });
    expect(result.current.needsSignIn).toBe(true);
    await send({ type: "ended", error: { kind: "forbidden", message: "no" } });
    expect(result.current.needsSignIn).toBe(false);
    expect(result.current.forbidden).toBe(true);
  });

  it("exposes needsSignIn when connect rejects and does not fetch", async () => {
    vi.mocked(client.connect).mockRejectedValueOnce({ kind: "not_signed_in", message: "x" });
    const { result } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(result.current.needsSignIn).toBe(true);
    expect(fetches()).toBe(0);
  });

  it("refetches when the window changes", async () => {
    const { rerender } = renderHook(({ since }) => useViewer(URL_, { since, limit: 500 }), {
      initialProps: { since: "1h" },
    });
    await settle();
    rerender({ since: "6h" });
    await settle();
    expect(fetches()).toBe(2);
    expect(vi.mocked(client.fetchGraph).mock.calls[1]).toEqual([URL_, "6h", 500]);
  });

  it("ignores frames for other servers and cleans up on unmount", async () => {
    const { result, unmount } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    act(() => handler!({ server: "https://other", frame: { type: "status", connected: true } }));
    expect(result.current.model.live).toBe(false);
    await send({ type: "event", kind: "run", data: runEvent("r1") });
    unmount();
    expect(unlisten).toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetches()).toBe(1);
  });
});
