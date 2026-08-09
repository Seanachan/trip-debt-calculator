// Static FX table + minor-unit conversion helpers for the expense-divider
// engine. Rates are fixed at build time (NOT live/fetched) — good enough for
// a trip-length static split, not for real-time money movement.

/** Every currency the engine understands. */
export type CurrencyCode = "USD" | "EUR" | "GBP" | "THB" | "TWD" | "JPY" | "KRW";

export interface CurrencyMeta {
  /** Prefix shown before the formatted amount. */
  symbol: string;
  /** Minor-unit decimal places (e.g. 2 for USD cents, 0 for JPY/THB). */
  decimals: number;
  /** Value of 1 unit of this currency in USD. USD's own rate is 1. */
  rate: number;
  /** Long bilingual label for pickers, e.g. "USD — 美元 ($)". */
  label: string;
  /** Short code + symbol, e.g. "USD $". */
  short: string;
}

export const CURRENCIES: Record<CurrencyCode, CurrencyMeta> = {
  USD: { symbol: "$", decimals: 2, rate: 1, label: "USD — 美元 ($)", short: "USD $" },
  EUR: { symbol: "€", decimals: 2, rate: 1.08, label: "EUR — 歐元 (€)", short: "EUR €" },
  GBP: { symbol: "£", decimals: 2, rate: 1.27, label: "GBP — 英鎊 (£)", short: "GBP £" },
  THB: { symbol: "฿", decimals: 0, rate: 0.028, label: "THB — 泰銖 (฿)", short: "THB ฿" },
  TWD: { symbol: "NT$", decimals: 2, rate: 0.031, label: "TWD — 新台幣 (NT$)", short: "TWD NT$" },
  JPY: { symbol: "¥", decimals: 0, rate: 0.0067, label: "JPY — 日圓 (¥)", short: "JPY ¥" },
  KRW: { symbol: "₩", decimals: 0, rate: 0.00072, label: "KRW — 韓元 (₩)", short: "KRW ₩" },
};

/** `Object.keys(CURRENCIES)` typed as `CurrencyCode[]`, for schemas/UI lists. */
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

/** A `code → value-of-1-unit-in-USD` map. USD is always 1. */
export type RateMap = Record<CurrencyCode, number>;

/**
 * The static fallback rates (the `rate` fields above), used when no live
 * rate map is supplied to `convert`/`computeBalances` and by `rates.ts` when
 * the live fetch fails.
 */
export const STATIC_RATES: RateMap = CURRENCY_CODES.reduce((acc, code) => {
  acc[code] = CURRENCIES[code].rate;
  return acc;
}, {} as RateMap);

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (CURRENCY_CODES as string[]).includes(value);
}

/** Convert a major-unit amount (e.g. dollars) to integer minor units. */
export function toMinor(major: number, code: CurrencyCode): number {
  return Math.round(major * 10 ** CURRENCIES[code].decimals);
}

/** Convert integer minor units back to a major-unit amount. */
export function fromMinor(minor: number, code: CurrencyCode): number {
  return minor / 10 ** CURRENCIES[code].decimals;
}

/**
 * Convert integer minor units of `from` into integer minor units of `to`,
 * routing through USD. Returns `minor` unchanged when `from === to` (no lossy
 * round-trip through USD for the common case). Pass a live `rates` map (e.g.
 * from `rates.ts`) to override the static table; omit it to use `STATIC_RATES`.
 */
export function convert(
  minor: number,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: RateMap = STATIC_RATES,
): number {
  if (from === to) {
    return minor;
  }
  const majorFrom = fromMinor(minor, from);
  const usd = majorFrom * rates[from];
  const majorTo = usd / rates[to];
  return toMinor(majorTo, to);
}

/** Format integer minor units as `<symbol><amount>`, e.g. "$10.00", "฿42,000". */
export function formatMoney(minor: number, code: CurrencyCode): string {
  const meta = CURRENCIES[code];
  const amount = fromMinor(minor, code).toLocaleString("en-US", {
    minimumFractionDigits: meta.decimals,
    maximumFractionDigits: meta.decimals,
  });
  return meta.symbol + amount;
}
