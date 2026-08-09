import type { Balance, Expense, PersonId, Person } from "./types";
import type { CurrencyCode, RateMap } from "./currency";
import { convert } from "./currency";
import { deriveWeights } from "./split";
import { largestRemainder } from "./money";

/**
 * Compute each member's paid/owed/net balance across all expenses, entirely
 * in `baseCurrency` minor units — every expense's own-currency `amount` is
 * converted to `baseCurrency` first (via the static FX table in
 * `currency.ts`), and per-participant owed shares are then distributed from
 * that converted amount with `largestRemainder`, so owed sums EXACTLY to the
 * converted amount for every expense (Σ over all members' `net` === 0).
 * Ids referenced by an expense but absent from `members` are skipped
 * defensively (no NaN, no phantom entries) — same as before, this means a
 * ghost participant's share is silently dropped rather than reassigned.
 */
export function computeBalances(
  members: Person[],
  expenses: Expense[],
  baseCurrency: CurrencyCode,
  rates?: RateMap,
): Balance[] {
  const paid = new Map<PersonId, number>();
  const owed = new Map<PersonId, number>();

  for (const m of members) {
    paid.set(m.id, 0);
    owed.set(m.id, 0);
  }

  for (const expense of expenses) {
    const baseAmount = convert(expense.amount, expense.currency, baseCurrency, rates);

    if (paid.has(expense.paidBy)) {
      paid.set(expense.paidBy, paid.get(expense.paidBy)! + baseAmount);
    }

    const { method, participants } = expense.split;
    const weights = deriveWeights(method, participants);
    const shares = largestRemainder(baseAmount, weights);

    participants.forEach((p, i) => {
      if (owed.has(p.personId)) {
        owed.set(p.personId, owed.get(p.personId)! + shares[i]);
      }
    });
  }

  return members.map((m) => {
    const p = paid.get(m.id) ?? 0;
    const o = owed.get(m.id) ?? 0;
    return { personId: m.id, paid: p, owed: o, net: p - o };
  });
}
