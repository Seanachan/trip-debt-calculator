import type { Cents } from "./types";

/** Convert a dollar (major-unit) amount to integer cents. */
export function toCents(dollars: number): Cents {
  return Math.round(dollars * 100);
}

/** Convert integer cents back to a dollar (major-unit) amount. */
export function fromCents(c: Cents): number {
  return c / 100;
}

/** Format integer cents as a localized currency string. */
export function formatMoney(c: Cents, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(fromCents(c));
}

/**
 * Distribute `total` integer cents across `weights` into integers that sum
 * EXACTLY to `total`, using the largest-remainder method. This is the core
 * money-safe rounding primitive for the whole engine.
 */
export function largestRemainder(total: Cents, weights: number[]): Cents[] {
  if (weights.length === 0) {
    return [];
  }

  const sumW = weights.reduce((a, b) => a + b, 0);
  const effectiveWeights = sumW <= 0 ? weights.map(() => 1) : weights;
  const effectiveSum = sumW <= 0 ? effectiveWeights.length : sumW;

  const floors: number[] = [];
  const fractions: number[] = [];
  let flooredTotal = 0;

  for (const w of effectiveWeights) {
    const raw = (total * w) / effectiveSum;
    const floor = Math.floor(raw);
    floors.push(floor);
    fractions.push(raw - floor);
    flooredTotal += floor;
  }

  let remainder = total - flooredTotal;

  // Rank indices by largest fractional part, tie-break by index ascending.
  const order = effectiveWeights
    .map((_, i) => i)
    .sort((a, b) => {
      const diff = fractions[b] - fractions[a];
      if (diff !== 0) return diff;
      return a - b;
    });

  const result = [...floors];
  for (let i = 0; i < order.length && remainder > 0; i++) {
    result[order[i]] += 1;
    remainder--;
  }

  return result;
}
