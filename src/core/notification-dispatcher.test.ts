import { describe, expect, it } from "vitest";
import { backoffMs, MAX_ATTEMPTS } from "./notification-dispatcher.js";

describe("backoffMs", () => {
  it("starts at 5 s and doubles per attempt", () => {
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(2)).toBe(10000);
    expect(backoffMs(3)).toBe(20000);
  });

  it("caps at one hour", () => {
    expect(backoffMs(20)).toBe(3_600_000);
    expect(backoffMs(MAX_ATTEMPTS + 100)).toBe(3_600_000);
  });

  it("treats attempts below 1 as the first attempt", () => {
    expect(backoffMs(0)).toBe(5000);
  });
});
