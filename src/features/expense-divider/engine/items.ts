// Itemised (依項目) splits: a bill entered line by line, each line shared by
// the people who had it.
//
// Lines are stored next to an ordinary "exact" split rather than as a split
// method of their own. `computeOwed`, `computeBalances` and settle-up already
// handle "exact", and an older build that has never heard of lines reads the
// same expense as plain "exact" and gets the same balances — where an unknown
// method would make it fall back to "equal".

import type { Cents, PersonId, SplitItem, SplitParticipant } from "./types";
import { largestRemainder } from "./money";

/**
 * Each person's total across every line they share. A line is divided evenly
 * among its sharers; spare minor units go to the payer when the payer shares
 * that line, otherwise to the earliest sharers in the line's own order.
 */
export function itemizedOwed(items: SplitItem[], payer: PersonId): Record<PersonId, Cents> {
  const owed: Record<PersonId, Cents> = {};
  for (const item of items) {
    const order = item.personIds.includes(payer)
      ? [payer, ...item.personIds.filter((id) => id !== payer)]
      : item.personIds;
    const shares = largestRemainder(
      item.amount,
      order.map(() => 1),
    );
    order.forEach((id, i) => {
      owed[id] = (owed[id] ?? 0) + shares[i];
    });
  }
  return owed;
}

/**
 * The "exact" participants an itemised split is stored as: everyone on any
 * line, once, in order of first appearance, valued at their `itemizedOwed`.
 */
export function itemizedParticipants(items: SplitItem[], payer: PersonId): SplitParticipant[] {
  const owed = itemizedOwed(items, payer);
  const seen = new Set<PersonId>();
  const participants: SplitParticipant[] = [];
  for (const item of items) {
    for (const id of item.personIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      participants.push({ personId: id, value: owed[id] });
    }
  }
  return participants;
}
