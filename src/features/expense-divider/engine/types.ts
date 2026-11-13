// Pure data contracts for the expense-divider engine. No I/O, no framework deps.
//
// Minor-unit currency convention (read before touching amounts):
//   - `Expense.amount` (and `exact`-split `SplitParticipant.value`) are
//     integer minor units OF THAT EXPENSE'S OWN `currency` — e.g. 1050 means
//     $10.50 for a USD expense but ¥1050 for a JPY expense (JPY has 0 minor
//     digits). Never compare/sum raw `Expense.amount` across expenses with
//     different currencies.
//   - `Balance` and `Settlement` amounts are always integer minor units of
//     the GROUP's `baseCurrency` (the `baseCurrency` argument passed to
//     `computeBalances`), regardless of what currency each expense was
//     entered in. `engine/currency.ts` (`convert`) is what bridges the two.

import type { CurrencyCode } from "./currency";

export type PersonId = string;

/** Integer minor units of *some* currency. Never a float — see convention above. */
export type Cents = number;

export interface Person {
  id: PersonId;
  name: string;
  /** Hex swatch for avatars/charts; from `PALETTE` in constants.ts. */
  color?: string;
}

/**
 * A spend bucket, owned and editable by the group (see `categories.ts` for the
 * seed list). `id` is what an expense stores and must never be reused for a
 * different bucket; `label`/`icon` are display-only and free to rename.
 */
export interface Category {
  id: string;
  label: string;
  icon: string;
}

export type SplitMethod = "equal" | "exact" | "percent" | "shares";

export interface SplitParticipant {
  personId: PersonId;
  /** exact=minor units of the expense's currency, percent=percentage points, shares=weight; ignored for "equal". */
  value?: number;
}

/**
 * One line of an itemised (依項目) split: what it cost, in minor units of the
 * expense's currency, and who shares it. Lines only ride along on an "exact"
 * split, whose participant values are what the lines add up to per person —
 * see `items.ts`.
 */
export interface SplitItem {
  label: string;
  amount: Cents;
  personIds: PersonId[];
}

export interface Expense {
  id: string;
  description: string;
  /**
   * Emoji tag written by builds before the sticker UI. No longer set on new
   * expenses or shown; kept so an edit does not strip it from old ones.
   */
  icon?: string;
  /** Total amount, integer minor units OF `currency` below, > 0. */
  amount: Cents;
  /** Currency this expense was entered/paid in. */
  currency: CurrencyCode;
  /** Single payer. */
  paidBy: PersonId;
  /**
   * `Category.id` from the group's list. Absent — or pointing at a category
   * the group has since deleted — reads as uncategorised in the totals.
   */
  category?: string;
  split: {
    method: SplitMethod;
    participants: SplitParticipant[];
    /**
     * Present when the split was entered line by line. The money paths never
     * read it — `participants` already holds the result — so a build that
     * predates it still computes the same balances.
     */
    items?: SplitItem[];
  };
  createdBy: PersonId;
  /** Epoch ms. */
  createdAt: number;
}

/** All amounts here are integer minor units of the group's `baseCurrency`. */
export interface Balance {
  personId: PersonId;
  paid: Cents;
  owed: Cents;
  /** net = paid - owed. net > 0 means owed money; net < 0 means owes money. */
  net: Cents;
}

/** `amount` is integer minor units of the group's `baseCurrency`. */
export interface Settlement {
  from: PersonId;
  to: PersonId;
  amount: Cents;
}
