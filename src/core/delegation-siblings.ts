/**
 * The children one run attempt's delegations have running right now, and a
 * signal for when any of them finishes. Used with the delegation gate
 * (serial-gate.ts) under Agent.parallelDelegations: a delegation refused for
 * budget while a sibling still runs waits for that sibling to finish and
 * free its hold, then tries again. A delegation that is waiting is not in
 * flight itself, so two waiting delegations never wait on each other.
 */
export interface DelegationSiblings {
  /** Children started and not yet finished. */
  readonly inFlight: number;
  /** Counts one child as running. Returns its finish, which is idempotent. */
  start(): () => void;
  /** Resolves true when a child finishes after this call, or false after timeoutMs. */
  nextFinish(timeoutMs: number): Promise<boolean>;
}

export function createDelegationSiblings(): DelegationSiblings {
  let inFlight = 0;
  const waiters = new Set<() => void>();
  return {
    get inFlight() {
      return inFlight;
    },
    start() {
      inFlight += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        inFlight -= 1;
        for (const wake of [...waiters]) wake();
      };
    },
    nextFinish(timeoutMs) {
      return new Promise<boolean>((resolve) => {
        const settle = (woken: boolean) => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(woken);
        };
        const wake = () => settle(true);
        const timer = setTimeout(() => settle(false), Math.max(0, timeoutMs));
        waiters.add(wake);
      });
    },
  };
}
