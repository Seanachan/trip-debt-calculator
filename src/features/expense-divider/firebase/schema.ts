// Mappers between raw Firestore document data and the pure engine's typed
// contracts. This is the only place that should know about Firestore's
// untyped document shape — everything past this module deals in engine
// types.

import type { Expense, Person, SplitMethod, SplitParticipant } from "../engine";
import { isCurrencyCode, type CurrencyCode } from "../engine";

export interface GroupInfo {
  name: string;
  baseCurrency: CurrencyCode;
}

export function groupFromDoc(data: Record<string, unknown>): GroupInfo {
  return {
    name: typeof data.name === "string" ? data.name : "",
    baseCurrency: isCurrencyCode(data.baseCurrency) ? data.baseCurrency : "USD",
  };
}

export function personFromDoc(id: string, data: Record<string, unknown>): Person {
  return {
    id,
    name: typeof data.name === "string" ? data.name : "",
    color: typeof data.color === "string" ? data.color : undefined,
  };
}

/**
 * Build the Firestore document body for a member. Firestore rejects
 * `undefined` field values, so `color` is only assigned when defined.
 */
export function personToDoc(person: Omit<Person, "id">): Record<string, unknown> {
  const out: Record<string, unknown> = { name: person.name };
  if (person.color !== undefined) out.color = person.color;
  return out;
}

function toSplitMethod(raw: unknown): SplitMethod {
  if (raw === "equal" || raw === "exact" || raw === "percent" || raw === "shares") {
    return raw;
  }
  return "equal";
}

function toSplitParticipant(raw: unknown): SplitParticipant {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const personId = typeof obj.personId === "string" ? obj.personId : "";
    return typeof obj.value === "number" ? { personId, value: obj.value } : { personId };
  }
  return { personId: "" };
}

function toSplitParticipants(raw: unknown): SplitParticipant[] {
  return Array.isArray(raw) ? raw.map(toSplitParticipant) : [];
}

export function expenseFromDoc(id: string, data: Record<string, unknown>): Expense {
  const splitRaw =
    data.split && typeof data.split === "object" ? (data.split as Record<string, unknown>) : {};

  return {
    id,
    description: typeof data.description === "string" ? data.description : "",
    icon: typeof data.icon === "string" ? data.icon : undefined,
    amount: typeof data.amount === "number" ? Math.round(data.amount) : 0,
    currency: isCurrencyCode(data.currency) ? data.currency : "USD",
    paidBy: typeof data.paidBy === "string" ? data.paidBy : "",
    split: {
      method: toSplitMethod(splitRaw.method),
      participants: toSplitParticipants(splitRaw.participants),
    },
    createdBy: typeof data.createdBy === "string" ? data.createdBy : "",
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
  };
}

/**
 * Build the Firestore document body for an expense. Takes the fields needed
 * to create one (no `id` — Firestore assigns that via the document key, and
 * `updateExpense` uses a separate partial patch rather than this mapper).
 * Firestore rejects `undefined` field values, so `icon` is only assigned
 * when defined.
 */
export function expenseToDoc(expense: Omit<Expense, "id">): Record<string, unknown> {
  const out: Record<string, unknown> = {
    description: expense.description,
    amount: expense.amount,
    currency: expense.currency,
    paidBy: expense.paidBy,
    split: expense.split,
    createdBy: expense.createdBy,
    createdAt: expense.createdAt,
  };
  if (expense.icon !== undefined) out.icon = expense.icon;
  return out;
}
