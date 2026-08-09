import { describe, it, expect } from "vitest";
import {
  CURRENCIES,
  CURRENCY_CODES,
  STATIC_RATES,
  isCurrencyCode,
  toMinor,
  fromMinor,
  convert,
  formatMoney,
} from "../currency";
import type { RateMap } from "../currency";

describe("CURRENCIES / CURRENCY_CODES", () => {
  it("has exactly the seven approved currencies", () => {
    expect(CURRENCY_CODES.sort()).toEqual(["EUR", "GBP", "JPY", "KRW", "THB", "TWD", "USD"]);
  });

  it("USD is the rate anchor", () => {
    expect(CURRENCIES.USD.rate).toBe(1);
  });

  it("JPY, THB and KRW have 0 decimals; the rest have 2", () => {
    expect(CURRENCIES.JPY.decimals).toBe(0);
    expect(CURRENCIES.THB.decimals).toBe(0);
    expect(CURRENCIES.KRW.decimals).toBe(0);
    for (const code of ["USD", "EUR", "GBP", "TWD"] as const) {
      expect(CURRENCIES[code].decimals).toBe(2);
    }
  });
});

describe("isCurrencyCode", () => {
  it("accepts known codes, rejects unknown", () => {
    expect(isCurrencyCode("USD")).toBe(true);
    expect(isCurrencyCode("THB")).toBe(true);
    expect(isCurrencyCode("XXX")).toBe(false);
    expect(isCurrencyCode(123)).toBe(false);
    expect(isCurrencyCode(undefined)).toBe(false);
  });
});

describe("toMinor / fromMinor", () => {
  it("round-trips for a 2-decimal currency", () => {
    expect(toMinor(10, "USD")).toBe(1000);
    expect(fromMinor(1000, "USD")).toBe(10);
    expect(toMinor(10.005, "USD")).toBe(1001); // rounds
  });

  it("round-trips for a 0-decimal currency", () => {
    expect(toMinor(42000, "THB")).toBe(42000);
    expect(fromMinor(42000, "THB")).toBe(42000);
    expect(toMinor(1500, "JPY")).toBe(1500);
  });

  it("round-trips across every currency without drift for whole major amounts", () => {
    for (const code of CURRENCY_CODES) {
      const minor = toMinor(7, code);
      expect(fromMinor(minor, code)).toBeCloseTo(7, 5);
    }
  });
});

describe("convert", () => {
  it("returns the amount unchanged when from === to", () => {
    expect(convert(12345, "USD", "USD")).toBe(12345);
    expect(convert(500, "THB", "THB")).toBe(500);
  });

  it("matches the approved hand-computed example: THB 42000 -> USD 117600", () => {
    // major_from = 42000 (THB has 0 decimals); usd = 42000*0.028 = 1176;
    // major_to = 1176/1 = 1176; minor_to = round(1176*100) = 117600.
    expect(convert(42000, "THB", "USD")).toBe(117600);
  });

  it("converts a known EUR amount to USD", () => {
    // major_from = 10.00; usd = 10*1.08 = 10.8; major_to = 10.8/1 = 10.8; minor = 1080.
    expect(convert(1000, "EUR", "USD")).toBe(1080);
  });

  it("converts JPY (0-decimal) to a 2-decimal currency", () => {
    // major_from=1000 yen; usd=1000*0.0067=6.7; major_to=6.7/1=6.7; minor=670.
    expect(convert(1000, "JPY", "USD")).toBe(670);
  });

  it("round-trip through USD and back is close to identity (rounding-tolerant)", () => {
    const original = 500000; // THB 500,000
    const toUsd = convert(original, "THB", "USD");
    const back = convert(toUsd, "USD", "THB");
    expect(Math.abs(back - original)).toBeLessThanOrEqual(1);
  });

  it("defaults to STATIC_RATES when no rates map is passed", () => {
    expect(STATIC_RATES.USD).toBe(1);
    expect(STATIC_RATES.EUR).toBe(CURRENCIES.EUR.rate);
    // omitting the 4th arg must match passing STATIC_RATES explicitly
    expect(convert(1000, "EUR", "USD")).toBe(convert(1000, "EUR", "USD", STATIC_RATES));
  });

  it("honours a live rates override (value of 1 unit in USD)", () => {
    // Pretend EUR jumped to 1.50 USD; everything else USD-anchored.
    const live: RateMap = { ...STATIC_RATES, EUR: 1.5 };
    // €10 -> usd = 10*1.5 = 15 -> USD minor 1500
    expect(convert(1000, "EUR", "USD", live)).toBe(1500);
    // and USD -> EUR uses the same override: $15 -> 15/1.5 = €10 -> 1000 minor
    expect(convert(1500, "USD", "EUR", live)).toBe(1000);
  });
});

describe("formatMoney", () => {
  it("formats 2-decimal currencies with their symbol and fixed decimals", () => {
    expect(formatMoney(1000, "USD")).toBe("$10.00");
    expect(formatMoney(1099, "USD")).toBe("$10.99");
    expect(formatMoney(108000, "EUR")).toBe("€1,080.00");
    expect(formatMoney(1000, "TWD")).toBe("NT$10.00");
  });

  it("formats 0-decimal currencies with no decimal point", () => {
    expect(formatMoney(42000, "THB")).toBe("฿42,000");
    expect(formatMoney(1500, "JPY")).toBe("¥1,500");
  });
});
