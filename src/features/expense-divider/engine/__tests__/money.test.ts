import { describe, it, expect } from "vitest";
import { toCents, fromCents, formatMoney, largestRemainder } from "../money";

describe("toCents / fromCents", () => {
  it("converts dollars to cents", () => {
    expect(toCents(10)).toBe(1000);
    expect(toCents(10.005)).toBe(1001); // rounds
    expect(toCents(0)).toBe(0);
  });

  it("converts cents back to dollars", () => {
    expect(fromCents(1000)).toBe(10);
    expect(fromCents(333)).toBeCloseTo(3.33, 5);
  });
});

describe("formatMoney", () => {
  it("formats cents as a currency string", () => {
    expect(formatMoney(1000)).toBe("$10.00");
    expect(formatMoney(333)).toBe("$3.33");
  });

  it("respects a custom currency", () => {
    expect(formatMoney(1000, "EUR")).toContain("10.00");
  });
});

describe("largestRemainder", () => {
  it("splits 1000 across three equal weights with deterministic remainder assignment", () => {
    const result = largestRemainder(1000, [1, 1, 1]);
    expect(result).toEqual([334, 333, 333]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("returns [] for empty weights", () => {
    expect(largestRemainder(1000, [])).toEqual([]);
  });

  it("returns [total] for a single weight", () => {
    expect(largestRemainder(777, [1])).toEqual([777]);
    expect(largestRemainder(777, [5])).toEqual([777]);
  });

  it("sums exactly to total for a variety of weights", () => {
    const cases: Array<[number, number[]]> = [
      [999, [50, 30, 20]],
      [100, [1, 1, 1, 1, 1, 1, 1]],
      [12345, [3, 1, 4, 1, 5, 9, 2, 6]],
      [1, [1, 1, 1]],
      [0, [1, 1, 1]],
    ];
    for (const [total, weights] of cases) {
      const result = largestRemainder(total, weights);
      expect(result).toHaveLength(weights.length);
      expect(result.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("falls back to equal weights when sumW <= 0", () => {
    const result = largestRemainder(100, [0, 0, 0]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
    expect(result).toEqual([34, 33, 33]);

    const negative = largestRemainder(90, [-1, -1, -1]);
    expect(negative.reduce((a, b) => a + b, 0)).toBe(90);
  });

  it("gives the remainder cent(s) to the largest fractional parts, tie-broken by ascending index", () => {
    // 999 / [50,30,20]: raw = 499.5, 299.7, 199.8 -> fractions .5,.7,.8
    // remainder=2 -> largest two fractions are index2 (.8) then index1 (.7)
    const result = largestRemainder(999, [50, 30, 20]);
    expect(result).toEqual([499, 300, 200]);
  });
});
