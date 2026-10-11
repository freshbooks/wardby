import { describe, expect, it } from "vitest";
import { loadLowPowerConfig } from "./low-power.js";

describe("loadLowPowerConfig", () => {
  it("is off by default", () => expect(loadLowPowerConfig({})).toEqual({ enabled: false, idleMinutes: 30 }));
  it("treats 0 as off", () => expect(loadLowPowerConfig({ WARDBY_LOW_POWER: "0" }).enabled).toBe(false));
  it("turns on with 1", () => expect(loadLowPowerConfig({ WARDBY_LOW_POWER: "1" }).enabled).toBe(true));
  it("rejects other values", () =>
    expect(() => loadLowPowerConfig({ WARDBY_LOW_POWER: "yes" })).toThrow(/WARDBY_LOW_POWER must be 0 or 1/));
  it("reads idle minutes", () =>
    expect(loadLowPowerConfig({ WARDBY_LOW_POWER: "1", LOW_POWER_IDLE_MINUTES: "5" }).idleMinutes).toBe(5));
  it.each(["4", "1441", "2.5", "x"])("rejects idle minutes %s", (v) =>
    expect(() => loadLowPowerConfig({ LOW_POWER_IDLE_MINUTES: v })).toThrow(
      /LOW_POWER_IDLE_MINUTES must be an integer from 5 to 1440/,
    ),
  );
});
