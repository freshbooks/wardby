import { describe, expect, it } from "vitest";
import { createSerialGate } from "./serial-gate.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createSerialGate", () => {
  it("admits one holder at a time, in acquire order", async () => {
    const gate = createSerialGate();
    const events: string[] = [];
    const holder = async (name: string) => {
      const release = await gate.acquire();
      events.push(`${name}:in`);
      await tick();
      events.push(`${name}:out`);
      release();
    };
    await Promise.all([holder("a"), holder("b"), holder("c")]);
    expect(events).toEqual(["a:in", "a:out", "b:in", "b:out", "c:in", "c:out"]);
  });

  it("treats a second release as a no-op", async () => {
    const gate = createSerialGate();
    const first = await gate.acquire();
    const second = gate.acquire();
    const third = gate.acquire();
    first();
    first();
    const releaseSecond = await second;
    let thirdIn = false;
    void third.then(() => (thirdIn = true));
    await tick();
    expect(thirdIn).toBe(false);
    releaseSecond();
    await third;
  });
});
