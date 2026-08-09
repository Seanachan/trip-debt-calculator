import { describe, it, expect } from "vitest";
import type { Category, Expense } from "../types";
import type { RateMap } from "../currency";
import { STATIC_RATES } from "../currency";
import { DEFAULT_CATEGORIES, UNCATEGORIZED, computeCategoryTotals } from "../categories";
import { computeBalances } from "../balances";

const categories: Category[] = [
  { id: "food", label: "餐飲", icon: "🍽️" },
  { id: "stay", label: "住宿", icon: "🏨" },
  { id: "transit", label: "交通", icon: "🚕" },
];

function expense(over: Partial<Expense> & Pick<Expense, "id" | "amount">): Expense {
  return {
    description: "x",
    currency: "USD",
    paidBy: "A",
    split: { method: "equal", participants: [{ personId: "A" }, { personId: "B" }] },
    createdBy: "A",
    createdAt: 0,
    ...over,
  };
}

describe("DEFAULT_CATEGORIES", () => {
  it("has unique ids that cannot collide with the uncategorised bucket", () => {
    const ids = DEFAULT_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(UNCATEGORIZED.id);
  });
});

describe("computeCategoryTotals", () => {
  it("sums per category, biggest first, with shares out of the trip total", () => {
    const rows = computeCategoryTotals(
      [
        expense({ id: "e1", amount: 1000, category: "food" }),
        expense({ id: "e2", amount: 500, category: "food" }),
        expense({ id: "e3", amount: 2500, category: "stay" }),
        expense({ id: "e4", amount: 1000, category: "transit" }),
      ],
      categories,
      "USD",
    );

    expect(rows.map((r) => [r.category.id, r.total, r.count])).toEqual([
      ["stay", 2500, 1],
      ["food", 1500, 2],
      ["transit", 1000, 1],
    ]);
    expect(rows.map((r) => r.share)).toEqual([50, 30, 20]);
  });

  it("drops categories nothing was filed under", () => {
    const rows = computeCategoryTotals(
      [expense({ id: "e1", amount: 100, category: "food" })],
      categories,
      "USD",
    );
    expect(rows.map((r) => r.category.id)).toEqual(["food"]);
  });

  it("buckets missing and dangling categories as uncategorised, always last", () => {
    const rows = computeCategoryTotals(
      [
        expense({ id: "e1", amount: 900 }),
        expense({ id: "e2", amount: 100, category: "deleted-category" }),
        expense({ id: "e3", amount: 50, category: "food" }),
      ],
      categories,
      "USD",
    );

    // Uncategorised outweighs 餐飲 20:1 and still sorts last.
    expect(rows.map((r) => r.category.id)).toEqual(["food", UNCATEGORIZED.id]);
    expect(rows[1].total).toBe(1000);
    expect(rows[1].count).toBe(2);
  });

  it("converts to the base currency, so totals reconcile with the balances", () => {
    const rates: RateMap = { ...STATIC_RATES, USD: 1, TWD: 0.03125, JPY: 0.00625 };
    const expenses = [
      // NT$32.00 -> $1.00 (100 minor); ¥1600 (JPY has no minor unit) -> $10.00.
      expense({ id: "e1", amount: 3200, currency: "TWD", category: "food" }),
      expense({ id: "e2", amount: 1600, currency: "JPY", category: "stay" }),
    ];

    const rows = computeCategoryTotals(expenses, categories, "USD", rates);
    expect(rows.map((r) => [r.category.id, r.total])).toEqual([
      ["stay", 1000],
      ["food", 100],
    ]);

    const paid = computeBalances(
      [
        { id: "A", name: "A" },
        { id: "B", name: "B" },
      ],
      expenses,
      "USD",
      rates,
    ).reduce((sum, b) => sum + b.paid, 0);
    expect(rows.reduce((sum, r) => sum + r.total, 0)).toBe(paid);
  });

  it("returns nothing, and never divides by zero, for a trip with no expenses", () => {
    expect(computeCategoryTotals([], categories, "USD")).toEqual([]);
  });

  it("reports a zero share rather than NaN when every expense is zero-valued", () => {
    const rows = computeCategoryTotals(
      [expense({ id: "e1", amount: 0, category: "food" })],
      categories,
      "USD",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].share).toBe(0);
  });
});
