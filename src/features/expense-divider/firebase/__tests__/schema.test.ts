import { describe, it, expect } from "vitest";
import { expenseFromDoc, expenseToDoc } from "../schema";

const doc = (split: Record<string, unknown>) => ({
  description: "晚餐",
  amount: 100,
  currency: "KRW",
  paidBy: "A",
  split,
  createdBy: "A",
  createdAt: 1,
});

describe("expenseFromDoc split items", () => {
  const items = [
    { label: "套餐", amount: 60, personIds: ["A"] },
    { label: "小菜", amount: 40, personIds: ["A", "B"] },
  ];
  const participants = [
    { personId: "A", value: 80 },
    { personId: "B", value: 20 },
  ];

  it("reads the lines of an exact split, and writes them back unchanged", () => {
    const expense = expenseFromDoc("e1", doc({ method: "exact", participants, items }));
    expect(expense.split.items).toEqual(items);

    const { id: _id, ...rest } = expense;
    void _id;
    expect(expenseToDoc(rest).split).toEqual({ method: "exact", participants, items });
  });

  it("leaves `items` off when there are none", () => {
    const expense = expenseFromDoc("e1", doc({ method: "exact", participants }));
    expect("items" in expense.split).toBe(false);
  });

  it("ignores lines on any other method", () => {
    const expense = expenseFromDoc("e1", doc({ method: "equal", participants, items }));
    expect(expense.split.items).toBeUndefined();
  });

  it("drops the whole list when one line is unreadable", () => {
    const broken = [...items, { label: "?", personIds: ["A"] }];
    const expense = expenseFromDoc("e1", doc({ method: "exact", participants, items: broken }));
    expect(expense.split.items).toBeUndefined();
    expect(expense.split.participants).toEqual(participants);
  });
});
