// Pure helpers for how the ledger presents people and days. No React, so the
// rules can be tested on their own.

import type { Expense } from "./engine";

const HAN = /\p{Script=Han}/u;

/**
 * The one character on a buddy's round badge. Han names show their last
 * character, which is the one friends call each other by (阿凱 → 凱, 小明 →
 * 明, 王大明 → 明); anything else shows its first letter, upper-cased.
 * `Array.from` so a character outside the BMP is not split in half.
 */
export function avatarChar(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length === 0) return "?";
  const last = chars[chars.length - 1];
  return HAN.test(last) ? last : chars[0].toUpperCase();
}

export interface ExpenseDay {
  /** Local calendar day, `YYYY-MM-DD`. Stable key for tabs. */
  key: string;
  /** 1 for the first day anything was spent; a day with nothing keeps its number. */
  dayNumber: number;
  /** `M/D`, the way the schedule's tabs write it. */
  label: string;
  isToday: boolean;
  expenses: Expense[];
}

function dayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Whole local days from `a` to `b`, immune to a DST hour. */
function daysBetween(a: Date, b: Date): number {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86_400_000);
}

/**
 * Expenses bucketed by the local day they were recorded, oldest day first.
 * Within a day they keep the order they were given in.
 */
export function groupByDay(expenses: Expense[], now: Date = new Date()): ExpenseDay[] {
  const byKey = new Map<string, { date: Date; expenses: Expense[] }>();
  for (const expense of expenses) {
    const date = new Date(expense.createdAt);
    const key = dayKey(date);
    const bucket = byKey.get(key);
    if (bucket) bucket.expenses.push(expense);
    else byKey.set(key, { date, expenses: [expense] });
  }

  const days = [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (days.length === 0) return [];

  const first = days[0][1].date;
  const today = dayKey(now);
  return days.map(([key, { date, expenses: dayExpenses }]) => ({
    key,
    dayNumber: daysBetween(first, date) + 1,
    label: `${date.getMonth() + 1}/${date.getDate()}`,
    isToday: key === today,
    expenses: dayExpenses,
  }));
}
