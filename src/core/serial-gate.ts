/**
 * A FIFO async mutex for one process. The runner uses one per run attempt
 * to admit delegations one at a time: the already-dispatched and limit
 * checks and the child row they guard must not interleave when several
 * delegate_to_* calls of one turn start together (parallelDelegations).
 */
export interface SerialGate {
  /** Resolves with this holder's release once every earlier holder released. */
  acquire(): Promise<() => void>;
}

export function createSerialGate(): SerialGate {
  let tail: Promise<void> = Promise.resolve();
  return {
    acquire() {
      let open!: () => void;
      const held = new Promise<void>((resolve) => (open = resolve));
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        open();
      };
      const turn = tail.then(() => release);
      tail = tail.then(() => held);
      return turn;
    },
  };
}
