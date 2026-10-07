import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PodView } from "./adapter";
import { LEAVE_MS, LINGER_MS, useEndedRuns } from "./endedRuns";

const pod = (name: string) => ({ name, title: name, containers: [] }) as unknown as PodView;

describe("useEndedRuns", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a gone pod for two minutes, then squashes it away", () => {
    const run = pod("wardby-run-a");
    const { result, rerender } = renderHook(({ live }) => useEndedRuns(live), { initialProps: { live: [run] } });
    expect(result.current.ended).toEqual([]);

    rerender({ live: [] });
    expect(result.current.ended.map((e) => [e.pod.name, e.leaving])).toEqual([["wardby-run-a", false]]);

    act(() => vi.advanceTimersByTime(LINGER_MS));
    expect(result.current.ended[0].leaving).toBe(true);
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(result.current.ended).toEqual([]);
  });

  it("closes early when dismissed", () => {
    const { result, rerender } = renderHook(({ live }) => useEndedRuns(live), {
      initialProps: { live: [pod("wardby-run-a")] },
    });
    rerender({ live: [] });
    act(() => result.current.dismiss("wardby-run-a"));
    expect(result.current.ended[0].leaving).toBe(true);
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(result.current.ended).toEqual([]);
  });

  it("drops the ended card if the pod comes back", () => {
    const run = pod("wardby-run-a");
    const { result, rerender } = renderHook(({ live }) => useEndedRuns(live), { initialProps: { live: [run] } });
    rerender({ live: [] });
    rerender({ live: [run] });
    expect(result.current.ended).toEqual([]);
    act(() => vi.advanceTimersByTime(LINGER_MS + LEAVE_MS));
    expect(result.current.ended).toEqual([]);
  });
});
