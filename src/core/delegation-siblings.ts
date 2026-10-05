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
  /** How many children have finished so far: pass it to nextFinish to not miss a finish in between. */
  readonly finishes: number;
  /** Counts one child as running. Returns its finish, which is idempotent. */
  start(): () => void;
  /**
   * Resolves true once a child finishes after `sinceFinishes` was read (at once if one already
   * has), or after this call when it is omitted; false after timeoutMs.
   */
  nextFinish(timeoutMs: number, sinceFinishes?: number): Promise<boolean>;
}

export function createDelegationSiblings(): DelegationSiblings {
  let inFlight = 0;
  let finishes = 0;
  const waiters = new Set<() => void>();
  return {
    get inFlight() {
      return inFlight;
    },
    get finishes() {
      return finishes;
    },
    start() {
      inFlight += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        inFlight -= 1;
        finishes += 1;
        for (const wake of [...waiters]) wake();
      };
    },
    nextFinish(timeoutMs, sinceFinishes = finishes) {
      if (finishes > sinceFinishes) return Promise.resolve(true);
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
