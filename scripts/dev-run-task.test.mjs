import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_BUDGET_USD, parseBudget } from "./dev-run-task.mjs";

test("an empty budget field falls back to the small default", () => {
  assert.equal(parseBudget(""), 0.1);
  assert.equal(parseBudget(undefined), 0.1);
  assert.equal(parseBudget("   "), 0.1);
});

test("accepts amounts up to and including the ceiling", () => {
  assert.equal(MAX_BUDGET_USD, 5);
  assert.equal(parseBudget("0.25"), 0.25);
  assert.equal(parseBudget("5"), 5);
});

test("rejects non-numeric, non-finite and non-positive budgets", () => {
  for (const raw of ["abc", "NaN", "Infinity", "-Infinity", "0", "-1", "-0.01"]) {
    assert.throws(() => parseBudget(raw), /positive number of USD/, raw);
  }
});

test("rejects anything above the 5 USD ceiling", () => {
  for (const raw of ["5.01", "6", "50", "1e9"]) {
    assert.throws(() => parseBudget(raw), /above the 5 USD dev ceiling/, raw);
  }
});
