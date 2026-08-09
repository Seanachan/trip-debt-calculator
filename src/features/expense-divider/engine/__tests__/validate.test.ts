import { describe, it, expect } from "vitest";
import type { Expense } from "../types";
import { validateExpense } from "../validate";

const memberIds = ["A", "B", "C"];

function baseExpense(overrides: Partial<Expense>): Expense {
  return {
    id: "e1",
    description: "test expense",
    amount: 900,
    currency: "USD",
    paidBy: "A",
    split: {
      method: "equal",
      participants: [{ personId: "A" }, { personId: "B" }, { personId: "C" }],
    },
    createdBy: "A",
    createdAt: 0,
    ...overrides,
  };
}

describe("validateExpense", () => {
  it("accepts a valid equal-split expense", () => {
    expect(validateExpense(baseExpense({}), memberIds)).toEqual([]);
  });

  it("accepts a valid exact-split expense summing to amount", () => {
    const expense = baseExpense({
      amount: 300,
      split: {
        method: "exact",
        participants: [
          { personId: "A", value: 100 },
          { personId: "B", value: 100 },
          { personId: "C", value: 100 },
        ],
      },
    });
    expect(validateExpense(expense, memberIds)).toEqual([]);
  });

  it("accepts a valid percent-split expense summing to 100", () => {
    const expense = baseExpense({
      split: {
        method: "percent",
        participants: [
          { personId: "A", value: 50 },
          { personId: "B", value: 30 },
          { personId: "C", value: 20 },
        ],
      },
    });
    expect(validateExpense(expense, memberIds)).toEqual([]);
  });

  it("accepts a percent split within floating-point tolerance of 100", () => {
    const expense = baseExpense({
      split: {
        method: "percent",
        participants: [
          { personId: "A", value: 33.34 },
          { personId: "B", value: 33.33 },
          { personId: "C", value: 33.33 },
        ],
      },
    });
    expect(validateExpense(expense, memberIds)).toEqual([]);
  });

  it("accepts a valid shares-split expense", () => {
    const expense = baseExpense({
      split: {
        method: "shares",
        participants: [
          { personId: "A", value: 1 },
          { personId: "B", value: 2 },
          { personId: "C", value: 1 },
        ],
      },
    });
    expect(validateExpense(expense, memberIds)).toEqual([]);
  });

  it("rejects amount <= 0", () => {
    const errors = validateExpense(baseExpense({ amount: 0 }), memberIds);
    expect(errors.length).toBeGreaterThan(0);

    const negErrors = validateExpense(baseExpense({ amount: -100 }), memberIds);
    expect(negErrors.length).toBeGreaterThan(0);
  });

  it("rejects a paidBy id that is not a member", () => {
    const errors = validateExpense(baseExpense({ paidBy: "Z" }), memberIds);
    expect(errors.some((e) => e.includes("Z"))).toBe(true);
  });

  it("rejects a participant id that is not a member", () => {
    const expense = baseExpense({
      split: {
        method: "equal",
        participants: [{ personId: "A" }, { personId: "Z" }],
      },
    });
    const errors = validateExpense(expense, memberIds);
    expect(errors.some((e) => e.includes("Z"))).toBe(true);
  });

  it("rejects an exact split that does not sum to amount", () => {
    const expense = baseExpense({
      amount: 300,
      split: {
        method: "exact",
        participants: [
          { personId: "A", value: 100 },
          { personId: "B", value: 100 },
          { personId: "C", value: 50 },
        ],
      },
    });
    const errors = validateExpense(expense, memberIds);
    expect(errors.some((e) => e.toLowerCase().includes("exact"))).toBe(true);
  });

  it("rejects a percent split that does not sum to 100", () => {
    const expense = baseExpense({
      split: {
        method: "percent",
        participants: [
          { personId: "A", value: 50 },
          { personId: "B", value: 30 },
          { personId: "C", value: 10 },
        ],
      },
    });
    const errors = validateExpense(expense, memberIds);
    expect(errors.some((e) => e.toLowerCase().includes("percent"))).toBe(true);
  });

  it("rejects duplicate participant ids", () => {
    const expense = baseExpense({
      split: {
        method: "equal",
        participants: [{ personId: "A" }, { personId: "A" }, { personId: "B" }],
      },
    });
    const errors = validateExpense(expense, memberIds);
    expect(errors.some((e) => e.toLowerCase().includes("duplicat"))).toBe(true);
  });

  it("rejects malformed shape (empty participants, bad method)", () => {
    const expense = baseExpense({
      split: { method: "equal", participants: [] },
    });
    const errors = validateExpense(expense, memberIds);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an unknown currency code", () => {
    const expense = { ...baseExpense({}), currency: "XXX" } as unknown as Expense;
    const errors = validateExpense(expense, memberIds);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts every known currency code", () => {
    for (const currency of ["USD", "EUR", "GBP", "THB", "TWD", "JPY", "KRW"] as const) {
      expect(validateExpense(baseExpense({ currency }), memberIds)).toEqual([]);
    }
  });
});
