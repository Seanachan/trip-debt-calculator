// Spend categories and the end-of-trip "where did the money go" rollup.
//
// Categories live on the group document, so a trip can rename them or add its
// own. Everything here treats that list as the source of truth and degrades
// gracefully when an expense points at a category the group has deleted.

import type { Category, Cents, Expense } from "./types";
import type { CurrencyCode, RateMap } from "./currency";
import { convert } from "./currency";

/**
 * Seeded into every new group, and used as the fallback for groups created
 * before categories existed. Ids are stable strings, never re-derived from the
 * label — renaming 「餐飲」 must not orphan the expenses filed under it.
 */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: "food", label: "餐飲", icon: "🍽️" },
  { id: "stay", label: "住宿", icon: "🏨" },
  { id: "transit", label: "交通", icon: "🚕" },
  { id: "fun", label: "娛樂", icon: "🎟️" },
  { id: "shopping", label: "購物", icon: "🛒" },
  { id: "other", label: "其他", icon: "📦" },
];

/**
 * Synthetic bucket for expenses with no category, or with one pointing at a
 * deleted category. Double-underscore so it can never collide with a
 * `newCategoryId()` value.
 */
export const UNCATEGORIZED: Category = { id: "__none", label: "未分類", icon: "🏷️" };

/**
 * Fresh id for a group-authored category. `getRandomValues` rather than
 * `randomUUID` because the latter is unavailable outside a secure context,
 * and a category should still be addable over plain http in dev.
 */
export function newCategoryId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `c_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface CategoryTotal {
  category: Category;
  /** Integer minor units of the base currency passed to `computeCategoryTotals`. */
  total: Cents;
  /** How many expenses landed in this bucket. */
  count: number;
  /** Percentage of the trip's total spend, 0–100. 0 when the trip total is 0. */
  share: number;
}

/**
 * Total spend per category, in `baseCurrency` minor units — each expense's
 * own-currency amount is converted first, exactly as `computeBalances` does,
 * so the category totals add up to the same trip total shown in the header.
 *
 * Buckets with nothing in them are dropped (an unused category is noise in a
 * summary), the rest are ordered biggest-first, and uncategorised spend is
 * pinned last regardless of size so the real categories read as a ranking.
 */
export function computeCategoryTotals(
  expenses: Expense[],
  categories: Category[],
  baseCurrency: CurrencyCode,
  rates?: RateMap,
): CategoryTotal[] {
  const known = new Map(categories.map((c) => [c.id, c] as const));
  const totals = new Map<string, { total: Cents; count: number }>();

  let tripTotal = 0;
  for (const expense of expenses) {
    const baseAmount = convert(expense.amount, expense.currency, baseCurrency, rates);
    const id =
      expense.category !== undefined && known.has(expense.category)
        ? expense.category
        : UNCATEGORIZED.id;
    const bucket = totals.get(id) ?? { total: 0, count: 0 };
    bucket.total += baseAmount;
    bucket.count += 1;
    totals.set(id, bucket);
    tripTotal += baseAmount;
  }

  // Walk `categories` (not the map) so equal totals keep the group's own order.
  const rows: CategoryTotal[] = [];
  for (const category of categories) {
    const bucket = totals.get(category.id);
    if (bucket && bucket.count > 0) {
      rows.push({ category, ...bucket, share: 0 });
    }
  }
  rows.sort((a, b) => b.total - a.total);

  const loose = totals.get(UNCATEGORIZED.id);
  if (loose && loose.count > 0) {
    rows.push({ category: UNCATEGORIZED, ...loose, share: 0 });
  }

  return rows.map((row) => ({
    ...row,
    share: tripTotal === 0 ? 0 : (row.total * 100) / tripTotal,
  }));
}
