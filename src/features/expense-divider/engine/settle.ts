import type { Balance, Cents, PersonId, Settlement } from "./types";

interface Party {
  id: PersonId;
  amt: Cents;
}

/**
 * Reduce a set of net balances to a minimal-ish set of pairwise transfers.
 * Uses a greedy largest-creditor/largest-debtor match, which is the standard
 * near-optimal heuristic for debt simplification — computing the true
 * minimum-transaction solution is NP-hard in general.
 * Produces at most n-1 transactions, all in integer cents.
 */
export function simplifyDebts(balances: Balance[]): Settlement[] {
  const creditors: Party[] = balances
    .filter((b) => b.net > 0)
    .map((b) => ({ id: b.personId, amt: b.net }));
  const debtors: Party[] = balances
    .filter((b) => b.net < 0)
    .map((b) => ({ id: b.personId, amt: -b.net }));

  const byAmtDescIdAsc = (a: Party, b: Party) =>
    b.amt - a.amt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  creditors.sort(byAmtDescIdAsc);
  debtors.sort(byAmtDescIdAsc);

  const settlements: Settlement[] = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor = debtors[di];
    const pay = Math.min(debtor.amt, creditor.amt);

    if (pay > 0) {
      settlements.push({ from: debtor.id, to: creditor.id, amount: pay });
      creditor.amt -= pay;
      debtor.amt -= pay;
    }

    if (creditor.amt === 0) ci++;
    if (debtor.amt === 0) di++;
  }

  return settlements;
}
