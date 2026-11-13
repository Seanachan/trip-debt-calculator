// Mappers between raw Firestore document data and the pure engine's typed
// contracts. This is the only place that should know about Firestore's
// untyped document shape — everything past this module deals in engine
// types.

import type {
  Category,
  Expense,
  Person,
  SplitItem,
  SplitMethod,
  SplitParticipant,
} from "../engine";
import { DEFAULT_CATEGORIES, isCurrencyCode, type CurrencyCode } from "../engine";

export interface GroupInfo {
  name: string;
  baseCurrency: CurrencyCode;
  /** Never empty — groups written before categories existed read the defaults. */
  categories: Category[];
}

function toCategory(raw: unknown): Category | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id === "") return null;
  return {
    id: obj.id,
    label: typeof obj.label === "string" ? obj.label : obj.id,
    icon: typeof obj.icon === "string" ? obj.icon : "🏷️",
  };
}

/**
 * A group with no usable `categories` field falls back to the defaults rather
 * than to an empty list: that covers groups created before this feature, and
 * means the picker is never empty.
 */
function toCategories(raw: unknown): Category[] {
  if (!Array.isArray(raw)) return DEFAULT_CATEGORIES;
  const parsed = raw.map(toCategory).filter((c): c is Category => c !== null);
  return parsed.length > 0 ? parsed : DEFAULT_CATEGORIES;
}

export function groupFromDoc(data: Record<string, unknown>): GroupInfo {
  return {
    name: typeof data.name === "string" ? data.name : "",
    baseCurrency: isCurrencyCode(data.baseCurrency) ? data.baseCurrency : "USD",
    categories: toCategories(data.categories),
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

function toSplitItem(raw: unknown): SplitItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.amount !== "number" || !Array.isArray(obj.personIds)) return null;
  return {
    label: typeof obj.label === "string" ? obj.label : "",
    amount: Math.round(obj.amount),
    personIds: obj.personIds.filter((id): id is string => typeof id === "string"),
  };
}

/**
 * Lines are display-only — `participants` carries the money — so an unreadable
 * list is dropped as a whole rather than half-kept: the expense then opens as
 * the plain exact split it is stored as.
 */
function toSplitItems(raw: unknown): SplitItem[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const items = raw.map(toSplitItem);
  return items.every((item): item is SplitItem => item !== null) ? items : undefined;
}

export function expenseFromDoc(id: string, data: Record<string, unknown>): Expense {
  const splitRaw =
    data.split && typeof data.split === "object" ? (data.split as Record<string, unknown>) : {};
  const method = toSplitMethod(splitRaw.method);
  const items = method === "exact" ? toSplitItems(splitRaw.items) : undefined;

  return {
    id,
    description: typeof data.description === "string" ? data.description : "",
    icon: typeof data.icon === "string" ? data.icon : undefined,
    amount: typeof data.amount === "number" ? Math.round(data.amount) : 0,
    currency: isCurrencyCode(data.currency) ? data.currency : "USD",
    paidBy: typeof data.paidBy === "string" ? data.paidBy : "",
    category:
      typeof data.category === "string" && data.category !== "" ? data.category : undefined,
    split: {
      method,
      participants: toSplitParticipants(splitRaw.participants),
      ...(items ? { items } : {}),
    },
    createdBy: typeof data.createdBy === "string" ? data.createdBy : "",
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
  };
}

/**
 * Build the Firestore document body for an expense. Takes the fields needed
 * to create one (no `id` — Firestore assigns that via the document key, and
 * `updateExpense` uses a separate partial patch rather than this mapper).
 * Firestore rejects `undefined` field values, so `icon` and `category` are
 * only assigned when defined.
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
  if (expense.category !== undefined) out.category = expense.category;
  return out;
}
