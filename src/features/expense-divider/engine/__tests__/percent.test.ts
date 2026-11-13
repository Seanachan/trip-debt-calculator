import { describe, it, expect } from "vitest";
import {
  PERCENT_DECIMALS,
  clampPercentInput,
  isEvenPercentSplit,
  percentSplitStrings,
  roundPercent,
} from "../percent";

describe("percentSplitStrings", () => {
  it("sums to exactly 100 for every party size", () => {
    for (let n = 1; n <= 24; n++) {
      const parts = percentSplitStrings(Array(n).fill(1));
      expect(parts).toHaveLength(n);
      const total = parts.reduce((sum, p) => sum + Number(p) * 10 ** PERCENT_DECIMALS, 0);
      expect(total).toBe(100 * 10 ** PERCENT_DECIMALS);
    }
  });

  it("puts the spare step on the first person for an uneven division", () => {
    expect(percentSplitStrings([1, 1, 1])).toEqual(["33.34", "33.33", "33.33"]);
  });

  it("drops trailing zeros so a clean split reads as a whole number", () => {
    expect(percentSplitStrings([1, 1])).toEqual(["50", "50"]);
    expect(percentSplitStrings([1, 1, 1, 1])).toEqual(["25", "25", "25", "25"]);
    expect(percentSplitStrings([1])).toEqual(["100"]);
  });

  it("honours unequal weights", () => {
    expect(percentSplitStrings([3, 1])).toEqual(["75", "25"]);
  });
});

describe("clampPercentInput", () => {
  it("keeps digits and one dot, and cuts past the grid", () => {
    expect(clampPercentInput("33.34")).toBe("33.34");
    expect(clampPercentInput("33.349")).toBe("33.34");
    expect(clampPercentInput("1.2.3")).toBe("1.2");
    expect(clampPercentInput("a1b2")).toBe("12");
    expect(clampPercentInput("100")).toBe("100");
  });

  it("survives the partial states of typing", () => {
    expect(clampPercentInput("")).toBe("");
    expect(clampPercentInput(".")).toBe(".");
    expect(clampPercentInput("33.")).toBe("33.");
  });
});

describe("roundPercent", () => {
  it("snaps onto the grid and keeps whole numbers whole", () => {
    expect(roundPercent(33.333333)).toBe(33.33);
    expect(roundPercent(9.0909)).toBe(9.09);
    expect(roundPercent(50)).toBe(50);
  });

  // What the 合計 readout depends on: however the float sum lands, the total of
  // a generated split must display as a clean 100 for every party size.
  it("displays a generated split's total as exactly 100, at any party size", () => {
    for (let n = 1; n <= 24; n++) {
      const total = percentSplitStrings(Array(n).fill(1)).reduce((sum, p) => sum + Number(p), 0);
      expect(roundPercent(total)).toBe(100);
    }
  });
});

describe("isEvenPercentSplit", () => {
  it("recognises what the even-split button generates, at any party size", () => {
    for (let n = 1; n <= 24; n++) {
      const generated = percentSplitStrings(Array(n).fill(1)).map(Number);
      expect(isEvenPercentSplit(generated)).toBe(true);
    }
  });

  it("rejects an uneven split", () => {
    expect(isEvenPercentSplit([50, 30, 20])).toBe(false);
    expect(isEvenPercentSplit([60, 40])).toBe(false);
  });

  it("rejects a hand-typed near-even split that moves the spare step", () => {
    // Same multiset as the generated 33.34/33.33/33.33, different carrier —
    // converting this to "equal" would silently shift a step to the first person.
    expect(isEvenPercentSplit([33.33, 33.34, 33.33])).toBe(false);
  });

  it("rejects a near-even split that does not reach 100", () => {
    expect(isEvenPercentSplit([33.33, 33.33, 33.33])).toBe(false);
  });

  it("rejects an empty participant list", () => {
    expect(isEvenPercentSplit([])).toBe(false);
  });
});
