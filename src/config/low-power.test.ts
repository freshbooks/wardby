import { describe, expect, it } from "vitest";
import { loadLowPowerConfig } from "./low-power.js";

describe("loadLowPowerConfig", () => {
  it("is off by default", () => expect(loadLowPowerConfig({})).toEqual({ enabled: false, idleMinutes: 30 }));
  it("treats 0 as off", () => expect(loadLowPowerConfig({ WARDBY_LOW_POWER: "0" }).enabled).toBe(false));
  it("turns on with 1", () => expect(loadLowPowerConfig({ WARDBY_LOW_POWER: "1" }).enabled).toBe(true));
  it("rejects other values", () =>
    expect(() => loadLowPowerConfig({ WARDBY_LOW_POWER: "yes" })).toThrow(/WARDBY_LOW_POWER must be 0 or 1/));
  it("validates WARDBY_LOW_POWER even with idle minutes set", () =>
    expect(() => loadLowPowerConfig({ WARDBY_LOW_POWER: "2", LOW_POWER_IDLE_MINUTES: "10" })).toThrow(
      /WARDBY_LOW_POWER must be 0 or 1/,
    ));
  it.each([
    ["5", 5],
    ["1440", 1440],
    [" 45 ", 45],
    ["", 30],
    ["   ", 30],
  ])("reads idle minutes %j", (v, minutes) =>
    expect(loadLowPowerConfig({ WARDBY_LOW_POWER: "1", LOW_POWER_IDLE_MINUTES: v }).idleMinutes).toBe(minutes),
  );
  it.each(["4", "1441", "2.5", "x", "0x1E", "3e1", "+30", "-30", "30m", "1 0"])("rejects idle minutes %j", (v) =>
    expect(() => loadLowPowerConfig({ WARDBY_LOW_POWER: "1", LOW_POWER_IDLE_MINUTES: v })).toThrow(
      /LOW_POWER_IDLE_MINUTES must be an integer from 5 to 1440/,
    ),
  );
  it.each([undefined, "0"])("ignores idle minutes entirely when WARDBY_LOW_POWER=%j", (flag) =>
    expect(loadLowPowerConfig({ WARDBY_LOW_POWER: flag, LOW_POWER_IDLE_MINUTES: "x" })).toEqual({
      enabled: false,
      idleMinutes: 30,
    }),
  );
  it("returns the default idle minutes when off, even with a valid value set", () =>
    expect(loadLowPowerConfig({ LOW_POWER_IDLE_MINUTES: "10" }).idleMinutes).toBe(30));
});
