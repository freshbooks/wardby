import { describe, expect, it } from "vitest";
import { formatEventTime } from "./time";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

describe("formatEventTime", () => {
  const now = at(2026, 10, 3, 12, 0); // a Saturday

  it("shows only the time today", () => {
    expect(formatEventTime(at(2026, 10, 3, 9, 5), now)).toBe("09:05");
  });

  it("adds the weekday within the last six days", () => {
    expect(formatEventTime(at(2026, 9, 28, 10, 52), now)).toBe("Mon 10:52");
  });

  it("adds month and day for anything older, or in the future", () => {
    expect(formatEventTime(at(2026, 9, 20, 10, 52), now)).toBe("Sep 20 10:52");
    expect(formatEventTime(at(2026, 10, 5, 8, 0), now)).toBe("Oct 5 08:00");
  });
});
