import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelegationSiblings } from "./delegation-siblings.js";

afterEach(() => vi.useRealTimers());

describe("createDelegationSiblings", () => {
  it("counts the children running and treats a second finish as a no-op", () => {
    const siblings = createDelegationSiblings();
    const a = siblings.start();
    const b = siblings.start();
    expect(siblings.inFlight).toBe(2);
    a();
    a();
    expect(siblings.inFlight).toBe(1);
    b();
    expect(siblings.inFlight).toBe(0);
  });

  it("wakes every waiter when one child finishes", async () => {
    const siblings = createDelegationSiblings();
    const finish = siblings.start();
    const first = siblings.nextFinish(60_000);
    const second = siblings.nextFinish(60_000);
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("gives up after the timeout with no finish", async () => {
    vi.useFakeTimers();
    const siblings = createDelegationSiblings();
    siblings.start();
    const waited = siblings.nextFinish(1_000);
    await vi.advanceTimersByTimeAsync(999);
    let done = false;
    void waited.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waited).resolves.toBe(false);
  });

  it("wakes at once for a finish since the given count, even one before the wait began", async () => {
    const siblings = createDelegationSiblings();
    const finish = siblings.start();
    const since = siblings.finishes;
    finish();
    expect(siblings.finishes).toBe(since + 1);
    await expect(siblings.nextFinish(60_000, since)).resolves.toBe(true);
  });

  it("does not count a finish before the wait when no count is given", async () => {
    vi.useFakeTimers();
    const siblings = createDelegationSiblings();
    siblings.start()();
    const waited = siblings.nextFinish(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(waited).resolves.toBe(false);
  });
});
