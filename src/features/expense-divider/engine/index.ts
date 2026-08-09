export type {
  PersonId,
  Cents,
  Person,
  SplitMethod,
  SplitParticipant,
  Expense,
  Balance,
  Settlement,
} from "./types";

export type { CurrencyCode, CurrencyMeta, RateMap } from "./currency";
export {
  CURRENCIES,
  CURRENCY_CODES,
  STATIC_RATES,
  isCurrencyCode,
  toMinor,
  fromMinor,
  convert,
  formatMoney,
} from "./currency";

// NOTE: money.ts's own `formatMoney` (Intl currency-code formatter) is
// intentionally NOT re-exported here — `currency.ts`'s `formatMoney` (fixed
// symbol/decimals table, multi-currency aware) is the canonical one for
// engine consumers. money.ts keeps its export for its own tests/internal use.
export { toCents, fromCents, largestRemainder } from "./money";
export { computeOwed, deriveWeights } from "./split";
export { computeBalances } from "./balances";
export { simplifyDebts } from "./settle";
export { PERCENT_TOLERANCE, expenseSchema, validateExpense } from "./validate";
