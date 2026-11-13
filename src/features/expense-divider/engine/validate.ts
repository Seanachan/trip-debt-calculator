import { z } from "zod";
import type { Expense } from "./types";
import { CURRENCY_CODES, type CurrencyCode } from "./currency";
import { itemizedOwed } from "./items";

const splitParticipantSchema = z.object({
  personId: z.string().min(1),
  value: z.number().optional(),
});

// A line may be negative: a discount on the receipt, shared like any other
// line. Each person's total must still be >= 0, which the exact-split check
// on `participants` enforces, since participants must equal the lines' totals.
const splitItemSchema = z.object({
  label: z.string(),
  amount: z
    .number()
    .int()
    .refine((n) => n !== 0, "a line must not be zero"),
  personIds: z.array(z.string().min(1)).min(1),
});

const currencyCodeSchema = z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]);

/** Shape-only schema: types, presence, basic constraints. No cross-field checks. */
export const expenseSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  icon: z.string().optional(),
  amount: z.number().int().positive(),
  currency: currencyCodeSchema,
  paidBy: z.string().min(1),
  // Not checked against the group's category list: a category deleted after
  // the fact leaves a dangling id, and that must not make the expense invalid.
  category: z.string().min(1).optional(),
  split: z.object({
    method: z.enum(["equal", "exact", "percent", "shares"]),
    participants: z.array(splitParticipantSchema).min(1),
    items: z.array(splitItemSchema).min(1).optional(),
  }),
  createdBy: z.string().min(1),
  createdAt: z.number(),
});

/**
 * Slack allowed when checking that percent splits sum to 100. Wide enough to
 * absorb float error from the UI's two-decimal (0.01-point) percentages, narrow
 * enough that a genuinely mis-entered split still fails.
 */
export const PERCENT_TOLERANCE = 0.01;

/**
 * Validate an expense's shape and business rules against a known member
 * list. Returns an array of human-readable error strings; empty = valid.
 */
export function validateExpense(
  expense: Expense,
  memberIds: string[],
): string[] {
  const errors: string[] = [];

  const shapeResult = expenseSchema.safeParse(expense);
  if (!shapeResult.success) {
    for (const issue of shapeResult.error.issues) {
      const path = issue.path.join(".") || "(root)";
      errors.push(`${path}: ${issue.message}`);
    }
    // Shape is broken enough that field-level checks below may not be
    // meaningful (e.g. participants missing) — bail out early.
    return errors;
  }

  const memberSet = new Set(memberIds);

  if (!memberSet.has(expense.paidBy)) {
    errors.push(`paidBy "${expense.paidBy}" is not a member`);
  }

  const { method, participants } = expense.split;

  const seenIds = new Set<string>();
  for (const p of participants) {
    if (!memberSet.has(p.personId)) {
      errors.push(`participant "${p.personId}" is not a member`);
    }
    if (seenIds.has(p.personId)) {
      errors.push(`participant "${p.personId}" is duplicated`);
    }
    seenIds.add(p.personId);
  }

  if (method === "exact") {
    let sum = 0;
    for (const p of participants) {
      if (p.value === undefined) {
        errors.push(`participant "${p.personId}" is missing an exact value`);
        continue;
      }
      if (!Number.isInteger(p.value) || p.value < 0) {
        errors.push(
          `participant "${p.personId}" exact value must be a non-negative integer`,
        );
        continue;
      }
      sum += p.value;
    }
    if (sum !== expense.amount) {
      errors.push(
        `exact split values sum to ${sum}, expected ${expense.amount}`,
      );
    }
  }

  if (method === "percent") {
    let sum = 0;
    for (const p of participants) {
      if (p.value === undefined || p.value <= 0) {
        errors.push(`participant "${p.personId}" percent value must be > 0`);
        continue;
      }
      sum += p.value;
    }
    if (Math.abs(sum - 100) > PERCENT_TOLERANCE) {
      errors.push(`percent split values sum to ${sum}, expected 100`);
    }
  }

  if (method === "shares") {
    for (const p of participants) {
      if (p.value === undefined || p.value <= 0) {
        errors.push(`participant "${p.personId}" shares value must be > 0`);
      }
    }
  }

  // "equal": non-empty participants already guaranteed by schema (min 1).

  const { items } = expense.split;
  if (items !== undefined) {
    if (method !== "exact") {
      errors.push(`split items need method "exact", got "${method}"`);
    }

    let itemsTotal = 0;
    items.forEach((item, i) => {
      itemsTotal += item.amount;
      const seenOnLine = new Set<string>();
      for (const id of item.personIds) {
        if (!memberSet.has(id)) {
          errors.push(`item ${i + 1} person "${id}" is not a member`);
        }
        if (seenOnLine.has(id)) {
          errors.push(`item ${i + 1} person "${id}" is duplicated`);
        }
        seenOnLine.add(id);
      }
    });
    if (itemsTotal !== expense.amount) {
      errors.push(`split items sum to ${itemsTotal}, expected ${expense.amount}`);
    }

    // The participants are what every money path reads, the lines are what the
    // editor shows: if they disagree, someone sees one bill and pays another.
    const fromItems = itemizedOwed(items, expense.paidBy);
    for (const p of participants) {
      const expected = fromItems[p.personId] ?? 0;
      if (p.value !== expected) {
        errors.push(
          `participant "${p.personId}" value ${p.value} does not match its items (${expected})`,
        );
      }
    }
    for (const id of Object.keys(fromItems)) {
      if (!seenIds.has(id)) {
        errors.push(`item person "${id}" is missing from participants`);
      }
    }
  }

  return errors;
}
