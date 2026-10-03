import { describe, expect, it } from "vitest";
import { exactUsd, formatUsd } from "./money";

describe("formatUsd", () => {
  it.each([
    [0, "$0"],
    [0.004213, "$0.0042"],
    [0.0042, "$0.0042"],
    [0.012, "$0.012"],
    [0.04, "$0.04"],
    [0.00031, "$0.00031"],
    [0.09999, "$0.10"],
    [0.1, "$0.10"],
    [0.26, "$0.26"],
    [1.2345, "$1.23"],
    [1234.5, "$1,234.50"],
    [0.0000004, "$0.0000004"],
    [-0.004213, "-$0.0042"],
    [-1.5, "-$1.50"],
    [-0.0999999999, "-$0.10"],
    [Number.NaN, "—"],
    [Number.POSITIVE_INFINITY, "—"],
    [Number.NEGATIVE_INFINITY, "—"],
    [1e-12, "$0"],
    [-1e-12, "$0"],
  ])("formats %s as %s", (v, out) => expect(formatUsd(v)).toBe(out));
});

describe("exactUsd", () => {
  it("shows 6 decimals", () => {
    expect(exactUsd(0.004213)).toBe("$0.004213");
    expect(exactUsd(0)).toBe("$0.000000");
    expect(exactUsd(1e-12)).toBe("$0.000000");
    expect(exactUsd(Number.NaN)).toBe("—");
    expect(exactUsd(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
