import { describe, expect, it } from "vitest";
import { createSliceBudget } from "../src/convergence/budget";

describe("convergence slice budget", () => {
  it("reserves checkpoint capacity and never starts a thirty-third provider call", () => {
    let now = 0;
    const budget = createSliceBudget(() => now, new AbortController().signal);

    for (let index = 0; index < 28; index += 1) budget.beforeHttp();
    expect(budget.canStartEffect(1)).toBe(false);
    for (let index = 0; index < 4; index += 1) budget.beforeHttp();
    expect(() => budget.beforeHttp()).toThrow("slice_budget_exhausted");

    now = 10_000;
    expect(budget.canStartEffect(1)).toBe(false);
  });
});
