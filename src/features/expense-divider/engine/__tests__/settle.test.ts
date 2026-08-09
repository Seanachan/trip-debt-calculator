import { describe, it, expect } from "vitest";
import type { Balance, Expense, Person } from "../types";
import { simplifyDebts } from "../settle";
import { computeBalances } from "../balances";

function totalsByPerson(settlements: { from: string; to: string; amount: number }[]) {
  const out = new Map<string, number>();
  const inn = new Map<string, number>();
  for (const s of settlements) {
    out.set(s.from, (out.get(s.from) ?? 0) + s.amount);
    inn.set(s.to, (inn.get(s.to) ?? 0) + s.amount);
  }
  return { out, inn };
}

describe("simplifyDebts", () => {
  it("nets out: each debtor pays exactly their debt, each creditor receives exactly their credit", () => {
    const balances: Balance[] = [
      { personId: "A", paid: 1000, owed: 0, net: 1000 },
      { personId: "B", paid: 0, owed: 400, net: -400 },
      { personId: "C", paid: 0, owed: 600, net: -600 },
    ];
    const settlements = simplifyDebts(balances);
    const { out, inn } = totalsByPerson(settlements);
    expect(out.get("B")).toBe(400);
    expect(out.get("C")).toBe(600);
    expect(inn.get("A")).toBe(1000);
  });

  it("produces at most n-1 transactions", () => {
    const balances: Balance[] = [
      { personId: "A", paid: 0, owed: 0, net: 500 },
      { personId: "B", paid: 0, owed: 0, net: 300 },
      { personId: "C", paid: 0, owed: 0, net: -200 },
      { personId: "D", paid: 0, owed: 0, net: -300 },
      { personId: "E", paid: 0, owed: 0, net: -300 },
    ];
    const settlements = simplifyDebts(balances);
    expect(settlements.length).toBeLessThanOrEqual(balances.length - 1);
    const { out, inn } = totalsByPerson(settlements);
    expect(out.get("C")).toBe(200);
    expect(out.get("D")).toBe(300);
    expect(out.get("E")).toBe(300);
    expect((inn.get("A") ?? 0) + (inn.get("B") ?? 0)).toBe(800);
  });

  it("is deterministic for the same input", () => {
    const balances: Balance[] = [
      { personId: "A", paid: 0, owed: 0, net: 333 },
      { personId: "B", paid: 0, owed: 0, net: -333 },
      { personId: "C", paid: 0, owed: 0, net: 333 },
      { personId: "D", paid: 0, owed: 0, net: -333 },
    ];
    const first = simplifyDebts(balances);
    const second = simplifyDebts(balances);
    expect(second).toEqual(first);
  });

  it("produces no transactions for a single person", () => {
    const balances: Balance[] = [{ personId: "A", paid: 0, owed: 0, net: 0 }];
    expect(simplifyDebts(balances)).toEqual([]);
  });

  it("produces no transactions when everyone is already settled", () => {
    const balances: Balance[] = [
      { personId: "A", paid: 100, owed: 100, net: 0 },
      { personId: "B", paid: 100, owed: 100, net: 0 },
      { personId: "C", paid: 100, owed: 100, net: 0 },
    ];
    expect(simplifyDebts(balances)).toEqual([]);
  });

  it("all integer cents", () => {
    const balances: Balance[] = [
      { personId: "A", paid: 0, owed: 0, net: 701 },
      { personId: "B", paid: 0, owed: 0, net: -401 },
      { personId: "C", paid: 0, owed: 0, net: -300 },
    ];
    for (const s of simplifyDebts(balances)) {
      expect(Number.isInteger(s.amount)).toBe(true);
    }
  });

  it("handles an uneven $10 equal split three ways end to end (A pays, B and C owe A their share)", () => {
    const members: Person[] = [
      { id: "A", name: "Alice" },
      { id: "B", name: "Bob" },
      { id: "C", name: "Carol" },
    ];
    const expenses: Expense[] = [
      {
        id: "e1",
        description: "lunch",
        amount: 1000, // $10.00
        currency: "USD",
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
    const settlements = simplifyDebts(balances);

    expect(settlements).toHaveLength(2);
    const { out, inn } = totalsByPerson(settlements);
    // owed shares: A=334 (own), B=333, C=333 -> A net = 1000-334 = 666
    expect(inn.get("A")).toBe(666);
    expect(out.get("B")).toBe(333);
    expect(out.get("C")).toBe(333);
    for (const s of settlements) {
      expect(s.to).toBe("A");
    }
  });
});
