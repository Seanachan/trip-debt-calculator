import { describe, it, expect } from "vitest";
import type { Expense, SplitItem } from "../types";
import { itemizedOwed, itemizedParticipants } from "../items";
import { computeOwed } from "../split";
import { computeBalances } from "../balances";
import { validateExpense } from "../validate";

// The design's example: a ₩100,000 dinner where one person had the big set.
const dinner: SplitItem[] = [
  { label: "韓牛套餐", amount: 52000, personIds: ["K"] },
  { label: "拌飯 ×3", amount: 36000, personIds: ["M", "A", "Y"] },
  { label: "小菜、飲料", amount: 12000, personIds: ["K", "M", "A", "Y"] },
];

function itemized(items: SplitItem[], paidBy = "K"): Expense {
  return {
    id: "e1",
    description: "烤肉晚餐",
    amount: items.reduce((sum, item) => sum + item.amount, 0),
    currency: "KRW",
    paidBy,
    split: { method: "exact", participants: itemizedParticipants(items, paidBy), items },
    createdBy: paidBy,
    createdAt: 0,
  };
}

describe("itemizedOwed", () => {
  it("adds up each person's share of every line they are on", () => {
    expect(itemizedOwed(dinner, "K")).toEqual({
      K: 52000 + 3000,
      M: 12000 + 3000,
      A: 12000 + 3000,
      Y: 12000 + 3000,
    });
  });

  it("always totals the lines exactly", () => {
    const owed = itemizedOwed(
      [
        { label: "a", amount: 100, personIds: ["A", "B", "C"] },
        { label: "b", amount: 7, personIds: ["B", "C"] },
      ],
      "A",
    );
    expect(Object.values(owed).reduce((a, b) => a + b, 0)).toBe(107);
  });

  it("gives a line's spare units to the payer when the payer shares it", () => {
    const line = [{ label: "a", amount: 100, personIds: ["A", "B", "C"] }];
    expect(itemizedOwed(line, "C")).toEqual({ A: 33, B: 33, C: 34 });
    expect(itemizedOwed(line, "B")).toEqual({ A: 33, B: 34, C: 33 });
  });

  it("falls back to list order when the payer is not on the line", () => {
    const line = [{ label: "a", amount: 100, personIds: ["A", "B", "C"] }];
    expect(itemizedOwed(line, "Z")).toEqual({ A: 34, B: 33, C: 33 });
  });
});

describe("itemizedParticipants", () => {
  it("lists each person once, in order of first appearance, with their total", () => {
    expect(itemizedParticipants(dinner, "K")).toEqual([
      { personId: "K", value: 55000 },
      { personId: "M", value: 15000 },
      { personId: "A", value: 15000 },
      { personId: "Y", value: 15000 },
    ]);
  });

  it("produces an exact split the existing money paths read unchanged", () => {
    const expense = itemized(dinner);
    expect(computeOwed(expense)).toEqual(itemizedOwed(dinner, "K"));

    const members = ["K", "M", "A", "Y"].map((id) => ({ id, name: id }));
    const balances = computeBalances(members, [expense], "KRW");
    expect(balances.find((b) => b.personId === "K")?.net).toBe(100000 - 55000);
    expect(balances.reduce((sum, b) => sum + b.net, 0)).toBe(0);
  });
});

describe("validateExpense with items", () => {
  const members = ["K", "M", "A", "Y"];

  it("accepts lines that agree with the participants", () => {
    expect(validateExpense(itemized(dinner), members)).toEqual([]);
  });

  it("rejects lines that do not add up to the amount", () => {
    const expense = { ...itemized(dinner), amount: 99000 };
    expect(validateExpense(expense, members)).toContain(
      "split items sum to 100000, expected 99000",
    );
  });

  it("rejects participants that disagree with the lines", () => {
    const expense = itemized(dinner);
    expense.split.participants = [
      { personId: "K", value: 25000 },
      { personId: "M", value: 25000 },
      { personId: "A", value: 25000 },
      { personId: "Y", value: 25000 },
    ];
    expect(validateExpense(expense, members)).toContain(
      "participant \"K\" value 25000 does not match its items (55000)",
    );
  });

  it("rejects a line nobody shares", () => {
    const lines = [...dinner, { label: "水", amount: 1000, personIds: [] }];
    const errors = validateExpense(itemized(lines), members);
    expect(errors.some((e) => e.startsWith("split.items.3.personIds"))).toBe(true);
  });

  it("rejects a line with a non-member or a repeated member", () => {
    const stranger = itemized([{ label: "a", amount: 100, personIds: ["K", "Z"] }]);
    expect(validateExpense(stranger, members)).toContain('item 1 person "Z" is not a member');

    const twice = itemized([{ label: "a", amount: 100, personIds: ["K", "K"] }]);
    expect(validateExpense(twice, members)).toContain('item 1 person "K" is duplicated');
  });

  it("accepts a discount line and gives the payer the smaller discount", () => {
    const lines = [
      { label: "烤肉", amount: 30000, personIds: ["K", "M", "A"] },
      { label: "折扣", amount: -1000, personIds: ["K", "M", "A"] },
    ];
    // -1000 / 3 leaves a spare unit, which the payer absorbs, as on a positive line.
    expect(itemizedOwed(lines, "K")).toEqual({ K: 10000 - 333, M: 10000 - 333, A: 10000 - 334 });
    expect(validateExpense(itemized(lines), members)).toEqual([]);
  });

  it("rejects a discount that leaves someone below zero", () => {
    const lines = [
      { label: "咖啡", amount: 5000, personIds: ["K"] },
      { label: "折扣", amount: -1000, personIds: ["M"] },
    ];
    expect(validateExpense(itemized(lines), members)).toContain(
      'participant "M" exact value must be a non-negative integer',
    );
  });

  it("rejects a zero line", () => {
    const lines = [...dinner, { label: "贈品", amount: 0, personIds: ["K"] }];
    const errors = validateExpense(itemized(lines), members);
    expect(errors.some((e) => e.includes("a line must not be zero"))).toBe(true);
  });

  it("rejects items on anything but an exact split", () => {
    const expense = itemized(dinner);
    expense.split.method = "equal";
    expect(validateExpense(expense, members)).toContain(
      'split items need method "exact", got "equal"',
    );
  });
});
