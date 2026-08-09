import type { Cents, Expense, PersonId, SplitMethod, SplitParticipant } from "./types";
import { largestRemainder } from "./money";

/**
 * Per-participant weights for a split method, shared by `computeOwed` (single
 * -currency, owed in the expense's own currency) and `computeBalances`
 * (multi-currency, owed distributed from a base-currency amount). "equal"
 * weighs everyone 1; "exact"/"percent"/"shares" all weigh by `value`
 * (for "exact" this means the entered minor-unit amounts are reused as
 * proportional weights when redistributing into a different currency).
 */
export function deriveWeights(method: SplitMethod, participants: SplitParticipant[]): number[] {
  return method === "equal" ? participants.map(() => 1) : participants.map((p) => p.value ?? 0);
}

/**
 * Compute how many minor units of `expense.amount` (in `expense.currency`)
 * each participant owes. For equal/shares/percent, uses largestRemainder so
 * the result always sums exactly to `expense.amount`. For exact, the given
 * values are used as-is (assumed pre-validated to sum to the amount) rather
 * than routed through largestRemainder.
 */
export function computeOwed(expense: Expense): Record<PersonId, Cents> {
  const { amount, split } = expense;
  const { method, participants } = split;

  const result: Record<PersonId, Cents> = {};

  if (method === "exact") {
    for (const p of participants) {
      result[p.personId] = Math.round(p.value ?? 0);
    }
    return result;
  }

  const weights = deriveWeights(method, participants);
  const shares = largestRemainder(amount, weights);
  participants.forEach((p, i) => {
    result[p.personId] = shares[i];
  });

  return result;
}
