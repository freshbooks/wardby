// Coding-run pods are deleted soon after their run ends. Keep each one on the map,
// marked ended, until the user closes it or it has been gone for LINGER_MS; then
// it squashes away (LEAVE_MS) and is dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PodView } from "./adapter";

export const LINGER_MS = 120_000;
/** Matches the `map-squash` animation; also the fallback when animations are off. */
export const LEAVE_MS = 350;

export interface EndedRun {
  pod: PodView;
  endedAt: number;
  leaving: boolean;
}

/** `enabled` is false while the pod list isn't trustworthy (not yet synced, reconnecting),
 *  so an empty list then doesn't mark every run as ended. */
export function useEndedRuns(
  live: readonly PodView[],
  enabled = true,
): {
  ended: EndedRun[];
  dismiss: (name: string) => void;
} {
  const [ended, setEnded] = useState<EndedRun[]>([]);
  const lastSeen = useRef(new Map<string, PodView>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const schedule = useCallback((name: string, ms: number, fn: () => void) => {
    clearTimeout(timers.current.get(name));
    timers.current.set(
      name,
      setTimeout(() => {
        timers.current.delete(name);
        fn();
      }, ms),
    );
  }, []);

  const remove = useCallback((name: string) => {
    setEnded((cur) => cur.filter((e) => e.pod.name !== name));
  }, []);

  const dismiss = useCallback(
    (name: string) => {
      setEnded((cur) => cur.map((e) => (e.pod.name === name ? { ...e, leaving: true } : e)));
      schedule(name, LEAVE_MS, () => remove(name));
    },
    [remove, schedule],
  );

  useEffect(() => {
    if (!enabled) return;
    const now = Date.now();
    const liveNames = new Set(live.map((p) => p.name));
    const gone = [...lastSeen.current.values()].filter((p) => !liveNames.has(p.name));
    lastSeen.current = new Map(live.map((p) => [p.name, p]));
    setEnded((cur) => {
      // A pod that came back (a brief watch gap) is live again, not ended.
      const kept = cur.filter((e) => !liveNames.has(e.pod.name));
      const added = gone
        .filter((p) => !kept.some((e) => e.pod.name === p.name))
        .map((pod) => ({ pod, endedAt: now, leaving: false }));
      return added.length === 0 && kept.length === cur.length ? cur : [...kept, ...added];
    });
    for (const p of gone) schedule(p.name, LINGER_MS, () => dismiss(p.name));
    for (const name of liveNames) {
      clearTimeout(timers.current.get(name));
      timers.current.delete(name);
    }
  }, [live, enabled, schedule, dismiss]);

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => clearTimeout(t));
  }, []);

  return { ended, dismiss };
}
