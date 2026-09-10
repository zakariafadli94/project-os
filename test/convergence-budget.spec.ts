import { describe, expect, it } from "vitest";
import {
  createSliceBudget,
  providerCheckpointScopeFor,
  providerRequestScopeFor
} from "../src/convergence/budget";

describe("convergence slice budget", () => {
  it("reserves checkpoint capacity and never starts a thirty-third provider call", () => {
    let now = 0;
    const budget = createSliceBudget(() => now, new AbortController().signal);

    for (let index = 0; index < 28; index += 1) budget.beforeHttp();
    expect(budget.canStartEffect(1)).toBe(false);
    for (let index = 0; index < 4; index += 1) budget.beforeHttp();
    expect(() => budget.beforeHttp()).toThrow("slice_budget_exhausted");

    now = 4_000;
    expect(budget.canStartEffect(1)).toBe(false);
  });

  it("exposes the same hard call budget to the Dropbox client", () => {
    const budget = createSliceBudget(() => 0, new AbortController().signal);
    const scope = providerRequestScopeFor(budget);

    for (let index = 0; index < 32; index += 1) scope.beforeHttp();
    expect(() => scope.beforeHttp()).toThrow("slice_budget_exhausted");
    expect(scope.deadlineMs).toBe(7_000);
  });

  it("stops provider work before the deadline reserved for the durable checkpoint", () => {
    let now = 0;
    const budget = createSliceBudget(() => now, new AbortController().signal);

    expect(providerRequestScopeFor(budget).deadlineMs).toBe(7_000);
    expect(providerCheckpointScopeFor(budget).deadlineMs).toBe(10_000);
    now = 4_000;
    expect(budget.canStartEffect(1)).toBe(false);
  });
});
