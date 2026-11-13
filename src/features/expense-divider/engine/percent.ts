// The percentage grid used by "percent" splits.
//
// Percentages are a lossy way to describe a division of money: 1/3 has no exact
// representation on any decimal grid, however many digits it gets. So the grid
// is defined once here — the UI's input mask, the generated splits and the
// display rounding all derive from `PERCENT_DECIMALS`, and `isEvenPercentSplit`
// lets a caller recognise a division that would be better stored as "equal"
// (which divides the money itself and never quantises the ratio at all).

import { largestRemainder } from "./money";

/**
 * Digits after the decimal point on a percentage. Two means 0.01-point steps,
 * so an even three-way split reads 33.34 / 33.33 / 33.33 and still totals 100.
 * Everything else in this module is derived, so re-gridding is a one-line change.
 */
export const PERCENT_DECIMALS = 2;

const STEPS_PER_POINT = 10 ** PERCENT_DECIMALS;
const TOTAL_STEPS = 100 * STEPS_PER_POINT;

/** Integer grid steps -> display string, with no trailing zeros ("50", not "50.00"). */
function formatPercent(steps: number): string {
  return String(steps / STEPS_PER_POINT);
}

/** Round an already-percentage number onto the grid, for display. */
export function roundPercent(pct: number): number {
  return Math.round(pct * STEPS_PER_POINT) / STEPS_PER_POINT;
}

/**
 * Distribute 100% across `weights` as on-grid strings summing to exactly 100.
 * Strings rather than numbers because these go straight into text inputs, and
 * the caller must not re-format (and so risk re-rounding) them.
 */
export function percentSplitStrings(weights: number[]): string[] {
  return largestRemainder(TOTAL_STEPS, weights).map(formatPercent);
}

/** Strip anything off-grid as it is typed: digits, one dot, `PERCENT_DECIMALS` decimals. */
export function clampPercentInput(raw: string): string {
  return raw
    .replace(/[^0-9.]/g, "")
    .replace(new RegExp(`^(\\d*\\.?\\d{0,${PERCENT_DECIMALS}}).*$`), "$1");
}

/**
 * Whether `values` are exactly the percentages this module would generate for
 * an even split between that many people — i.e. the output of the "平均分"
 * button, left untouched.
 *
 * Deliberately an exact positional match, not "near enough to even". An even
 * split is not all-percentages-equal: three people get 33.34 / 33.33 / 33.33,
 * and which person carries the spare step is decided by `largestRemainder`.
 * Accepting a hand-typed 33.33 / 33.34 / 33.33 would mean silently moving that
 * step from the middle person to the first one when the caller re-stores it as
 * "equal", so those are left as literal percentages instead.
 */
export function isEvenPercentSplit(values: number[]): boolean {
  if (values.length === 0) return false;
  const even = percentSplitStrings(values.map(() => 1));
  return values.every((value, i) => value === Number(even[i]));
}
