import { useMemo, useSyncExternalStore } from "react";

// One shared 1 s ticker for every running node: the interval starts with the
// first subscriber and stops with the last.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let current = Date.now();

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    // Refresh on (re)start so elapsed time never begins from a stale reading.
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const l of [...listeners]) l();
    }, 1000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const noopSubscribe = () => () => {};

/** Current time floored to `stepMs`, so consumers re-render only when that step changes. */
function snapshotFor(stepMs: number): () => number {
  return stepMs <= 1 ? () => current : () => Math.floor(current / stepMs) * stepMs;
}

/**
 * Current time, updated every second (or every `stepMs`, floored) while `active`;
 * inactive consumers never subscribe.
 */
export function useClock(active: boolean, stepMs = 1): number {
  const getSnapshot = useMemo(() => snapshotFor(stepMs), [stepMs]);
  return useSyncExternalStore(active ? subscribe : noopSubscribe, getSnapshot);
}
