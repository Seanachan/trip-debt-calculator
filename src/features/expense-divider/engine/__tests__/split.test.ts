import { describe, it, expect } from "vitest";
import type { Expense } from "../types";
import { computeOwed } from "../split";

function baseExpense(overrides: Partial<Expense>): Expense {
  return {
    id: "e1",
    description: "test expense",
    amount: 1000,
    currency: "USD",
    paidBy: "A",
    split: { method: "equal", participants: [] },
    createdBy: "A",
    createdAt: 0,
    ...overrides,
  };
}

describe("computeOwed", () => {
  it("equal: splits amount across participants via largestRemainder", () => {
    const expense = baseExpense({
      amount: 1000,
      split: {
        method: "equal",
        participants: [{ personId: "A" }, { personId: "B" }, { personId: "C" }],
      },
    });
    const owed = computeOwed(expense);
    expect(owed).toEqual({ A: 334, B: 333, C: 333 });
    expect(Object.values(owed).reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("shares: distributes proportionally to weights with remainder handling", () => {
    const expense = baseExpense({
      amount: 100,
      split: {
        method: "shares",
        participants: [
          { personId: "A", value: 1 },
          { personId: "B", value: 1 },
          { personId: "C", value: 1 },
        ],
      },
    });
    const owed = computeOwed(expense);
    expect(owed).toEqual({ A: 34, B: 33, C: 33 });
    expect(Object.values(owed).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("shares: weighted split sums exactly to amount", () => {
    const expense = baseExpense({
      amount: 400,
      split: {
        method: "shares",
        participants: [
          { personId: "A", value: 1 },
          { personId: "B", value: 2 },
          { personId: "C", value: 1 },
        ],
      },
    });
    const owed = computeOwed(expense);
    expect(owed).toEqual({ A: 100, B: 200, C: 100 });
  });

  it("percent: distributes by percentage weights, sums exactly to amount", () => {
    const expense = baseExpense({
      amount: 999,
      split: {
        method: "percent",
        participants: [
          { personId: "A", value: 50 },
          { personId: "B", value: 30 },
          { personId: "C", value: 20 },
        ],
      },
    });
    const owed = computeOwed(expense);
    expect(owed).toEqual({ A: 499, B: 300, C: 200 });
    expect(Object.values(owed).reduce((a, b) => a + b, 0)).toBe(999);
  });

  it("exact: returns given cents directly without renormalizing", () => {
    const expense = baseExpense({
      amount: 1000,
      split: {
        method: "exact",
        participants: [
          { personId: "A", value: 300 },
          { personId: "B", value: 400 },
          { personId: "C", value: 300 },
        ],
      },
    });
    const owed = computeOwed(expense);
    expect(owed).toEqual({ A: 300, B: 400, C: 300 });
  });

  it("exact: rounds non-integer values instead of rejecting them", () => {
    const expense = baseExpense({
      amount: 1000,
      split: {
        method: "exact",
        participants: [{ personId: "A", value: 300.4 }, { personId: "B", value: 699.6 }],
      },
    });
    const owed = computeOwed(expense);
    expect(owed).toEqual({ A: 300, B: 700 });
  });
});
