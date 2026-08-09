// Live FX rates from the free, key-less fawazahmed0/exchange-api
// (https://github.com/fawazahmed0/exchange-api), with the engine's STATIC_RATES
// as an offline/failure fallback. This is the one I/O boundary for currency —
// the engine itself stays pure and takes a RateMap.

import type { CurrencyCode, RateMap } from "./engine";
import { CURRENCY_CODES, STATIC_RATES } from "./engine";

// Primary CDN + its documented fallback host. base=usd → `usd` maps how many of
// each currency equal 1 USD (lowercase codes).
const HOSTS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
];

/**
 * Fetch live rates as a `code → value-of-1-unit-in-USD` map for the currencies
 * the engine knows. The API gives `usd[code] = units of code per 1 USD`, so our
 * convention is `1 / usd[code]`; USD itself is 1. Any failure (network, parse,
 * missing/invalid code) falls back to `STATIC_RATES` so the app still works.
 */
export async function fetchRates(): Promise<RateMap> {
  for (const url of HOSTS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data: unknown = await res.json();
      const usd = (data as { usd?: Record<string, unknown> } | null)?.usd;
      if (!usd || typeof usd !== "object") continue;

      const out: RateMap = { ...STATIC_RATES };
      let complete = true;
      for (const code of CURRENCY_CODES) {
        if (code === "USD") {
          out.USD = 1;
          continue;
        }
        const perUsd = usd[code.toLowerCase()];
        if (typeof perUsd !== "number" || !(perUsd > 0)) {
          complete = false;
          break;
        }
        out[code as CurrencyCode] = 1 / perUsd;
      }
      if (complete) return out;
    } catch {
      // try the next host
    }
  }
  return { ...STATIC_RATES };
}
