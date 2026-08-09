import { describe, it, expect } from "vitest";
import type { Expense, Person } from "../types";
import { computeBalances } from "../balances";

const members: Person[] = [
  { id: "A", name: "Alice" },
  { id: "B", name: "Bob" },
  { id: "C", name: "Carol" },
];

describe("computeBalances", () => {
  it("matches a hand-computed multi-expense scenario", () => {
    const expenses: Expense[] = [
      {
        id: "e1",
        description: "dinner",
        amount: 1000,
        currency: "USD",
        paidBy: "A",
        split: {
          method: "equal",
          participants: [{ personId: "A" }, { personId: "B" }, { personId: "C" }],
        },
        createdBy: "A",
        createdAt: 0,
      },
      {
        id: "e2",
        description: "cabs",
        amount: 600,
        currency: "USD",
        paidBy: "B",
        split: {
          method: "equal",
          participants: [{ personId: "A" }, { personId: "B" }, { personId: "C" }],
        },
        createdBy: "B",
        createdAt: 1,
      },
      {
        id: "e3",
        description: "snacks",
        amount: 300,
        currency: "USD",
        paidBy: "C",
        split: {
          method: "exact",
          participants: [
            { personId: "A", value: 100 },
            { personId: "B", value: 100 },
            { personId: "C", value: 100 },
          ],
        },
        createdBy: "C",
        createdAt: 2,
      },
    ];

    const balances = computeBalances(members, expenses, "USD");

    // Hand-computed: e1 equal(1000/3)=[334,333,333]; e2 equal(600/3)=[200,200,200]; e3 exact=[100,100,100]
    expect(balances).toEqual([
      { personId: "A", paid: 1000, owed: 634, net: 366 },
      { personId: "B", paid: 600, owed: 633, net: -33 },
      { personId: "C", paid: 300, owed: 633, net: -333 },
    ]);
  });

  it("keeps net balances summing to zero when everyone involved is a member", () => {
    const expenses: Expense[] = [
      {
        id: "e1",
        description: "groceries",
        amount: 5000,
        currency: "USD",
        paidBy: "A",
        split: {
          method: "shares",
          participants: [
            { personId: "A", value: 2 },
            { personId: "B", value: 1 },
            { personId: "C", value: 1 },
          ],
        },
        createdBy: "A",
        createdAt: 0,
      },
      {
        id: "e2",
        description: "hotel",
        amount: 12345,
        currency: "USD",
        paidBy: "C",
        split: {
          method: "percent",
          participants: [
            { personId: "A", value: 40 },
            { personId: "B", value: 35 },
            { personId: "C", value: 25 },
          ],
        },
        createdBy: "C",
        createdAt: 1,
      },
    ];

    const balances = computeBalances(members, expenses, "USD");
    const sumNet = balances.reduce((acc, b) => acc + b.net, 0);
    expect(sumNet).toBe(0);
  });

  it("returns balances in members order", () => {
    const balances = computeBalances(members, [], "USD");
    expect(balances.map((b) => b.personId)).toEqual(["A", "B", "C"]);
    expect(balances.every((b) => b.paid === 0 && b.owed === 0 && b.net === 0)).toBe(
      true,
    );
  });

  it("defensively skips ids that reference non-members instead of producing NaN", () => {
    const twoMembers: Person[] = [
      { id: "A", name: "Alice" },
      { id: "B", name: "Bob" },
    ];
    const expenses: Expense[] = [
      {
        id: "e1",
        description: "ghost participant",
        amount: 100,
        currency: "USD",
        paidBy: "A",
        split: {
          method: "equal",
          participants: [{ personId: "A" }, { personId: "B" }, { personId: "X" }],
        },
        createdBy: "A",
        createdAt: 0,
      },
    ];

    const balances = computeBalances(twoMembers, expenses, "USD");
    expect(balances).toHaveLength(2);
    for (const b of balances) {
      expect(Number.isNaN(b.paid)).toBe(false);
      expect(Number.isNaN(b.owed)).toBe(false);
      expect(Number.isNaN(b.net)).toBe(false);
    }
    const alice = balances.find((b) => b.personId === "A")!;
    expect(alice.paid).toBe(100);
  });

  it("skips a paidBy id that is not a member", () => {
    const expenses: Expense[] = [
      {
        id: "e1",
        description: "outsider paid",
        amount: 300,
        currency: "USD",
        paidBy: "Z",
        split: {
          method: "equal",
          participants: [{ personId: "A" }, { personId: "B" }],
        },
        createdBy: "A",
        createdAt: 0,
      },
    ];
    const balances = computeBalances(members, expenses, "USD");
    const total = balances.reduce((acc, b) => acc + b.paid, 0);
    expect(total).toBe(0);
  });

  describe("multi-currency", () => {
    it("converts a non-base-currency expense into baseCurrency before splitting (hand-checked)", () => {
      // THB 42000 minor (0 decimals => ฿42,000) paid by A, split equal A/B/C.
      // convert: major_from=42000, usd=42000*0.028=1176, major_to(USD)=1176/1=1176 => 117600 minor.
      // equal split of 117600 across 3 -> largestRemainder(117600,[1,1,1]) = [39200,39200,39200].
      const expenses: Expense[] = [
        {
          id: "e1",
          description: "hotel (THB)",
          amount: 42000,
          currency: "THB",
          paidBy: "A",
          split: {
            method: "equal",
            participants: [{ personId: "A" }, { personId: "B" }, { personId: "C" }],
          },
          createdBy: "A",
          createdAt: 0,
        },
      ];

      const balances = computeBalances(members, expenses, "USD");
      expect(balances).toEqual([
        { personId: "A", paid: 117600, owed: 39200, net: 78400 },
        { personId: "B", paid: 0, owed: 39200, net: -39200 },
        { personId: "C", paid: 0, owed: 39200, net: -39200 },
      ]);
    });

    it("keeps Σnet === 0 in base minor units across mixed-currency expenses", () => {
      const expenses: Expense[] = [
        {
          id: "e1",
          description: "dinner (USD)",
          amount: 1099,
          currency: "USD",
          paidBy: "A",
          split: {
            method: "equal",
            participants: [{ personId: "A" }, { personId: "B" }, { personId: "C" }],
          },
          createdBy: "A",
          createdAt: 0,
        },
        {
          id: "e2",
          description: "tuk-tuks (THB)",
          amount: 25000,
          currency: "THB",
          paidBy: "B",
          split: {
            method: "shares",
            participants: [
              { personId: "A", value: 1 },
              { personId: "B", value: 1 },
              { personId: "C", value: 2 },
            ],
          },
          createdBy: "B",
          createdAt: 1,
        },
        {
          id: "e3",
          description: "onsen (JPY)",
          amount: 8000,
          currency: "JPY",
          paidBy: "C",
          split: {
            method: "exact",
            participants: [
              { personId: "A", value: 3000 },
              { personId: "B", value: 2500 },
              { personId: "C", value: 2500 },
            ],
          },
          createdBy: "C",
          createdAt: 2,
        },
      ];

      const balances = computeBalances(members, expenses, "TWD");
      const sumNet = balances.reduce((acc, b) => acc + b.net, 0);
      expect(sumNet).toBe(0);
      for (const b of balances) {
        expect(Number.isInteger(b.paid)).toBe(true);
        expect(Number.isInteger(b.owed)).toBe(true);
      }
    });

    it("returns the same result when baseCurrency matches a single-currency expense set as the un-parameterized case", () => {
      const expenses: Expense[] = [
        {
          id: "e1",
          description: "lunch",
          amount: 1000,
          currency: "EUR",
          paidBy: "A",
          split: {
            method: "equal",
            participants: [{ personId: "A" }, { personId: "B" }, { personId: "C" }],
          },
          createdBy: "A",
          createdAt: 0,
        },
      ];
      // baseCurrency === expense currency -> convert() is identity, so this
      // should match a plain single-currency equal split of 1000.
      const balances = computeBalances(members, expenses, "EUR");
      expect(balances).toEqual([
        { personId: "A", paid: 1000, owed: 334, net: 666 },
        { personId: "B", paid: 0, owed: 333, net: -333 },
        { personId: "C", paid: 0, owed: 333, net: -333 },
      ]);
    });
  });
});
