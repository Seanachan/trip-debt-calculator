import { z } from "zod";
import type { Expense } from "./types";
import { CURRENCY_CODES, type CurrencyCode } from "./currency";

const splitParticipantSchema = z.object({
  personId: z.string().min(1),
  value: z.number().optional(),
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
  }),
  createdBy: z.string().min(1),
  createdAt: z.number(),
});

/**
 * Slack allowed when checking that percent splits sum to 100. Wide enough to
 * absorb float error from one-decimal (0.1-point) percentages, narrow enough
 * that a genuinely mis-entered split still fails.
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

  return errors;
}
