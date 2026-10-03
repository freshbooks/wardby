import { useSyncExternalStore } from "react";

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
const getSnapshot = () => current;

/** Current time, updated every second while `active`; inactive consumers never subscribe. */
export function useClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : noopSubscribe, getSnapshot);
}
