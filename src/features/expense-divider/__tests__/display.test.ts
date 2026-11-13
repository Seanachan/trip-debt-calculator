import { describe, it, expect } from "vitest";
import type { Expense } from "../engine";
import { avatarChar, groupByDay } from "../display";

describe("avatarChar", () => {
  it("uses the last character of a Han name", () => {
    expect(avatarChar("阿凱")).toBe("凱");
    expect(avatarChar("小明")).toBe("明");
    expect(avatarChar("王大明")).toBe("明");
    expect(avatarChar("陳")).toBe("陳");
  });

  it("uses the first letter of anything else", () => {
    expect(avatarChar("sean chen")).toBe("S");
    expect(avatarChar("  amy ")).toBe("A");
  });

  it("does not split a character outside the BMP", () => {
    expect(avatarChar("𠮷野")).toBe("野");
    expect(avatarChar("野𠮷")).toBe("𠮷");
  });

  it("has something to show for an empty name", () => {
    expect(avatarChar("   ")).toBe("?");
  });
});

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();

function expense(id: string, createdAt: number): Expense {
  return {
    id,
    description: id,
    amount: 100,
    currency: "USD",
    paidBy: "A",
    split: { method: "equal", participants: [{ personId: "A" }] },
    createdBy: "A",
    createdAt,
  };
}

describe("groupByDay", () => {
  it("buckets by local day, oldest day first, keeping order within a day", () => {
    const days = groupByDay(
      [
        expense("late", at(2026, 8, 16, 21)),
        expense("first", at(2026, 8, 14, 9)),
        expense("early", at(2026, 8, 16, 8)),
      ],
      new Date(2026, 7, 20),
    );
    expect(days.map((d) => d.key)).toEqual(["2026-08-14", "2026-08-16"]);
    expect(days[1].expenses.map((e) => e.id)).toEqual(["late", "early"]);
  });

  it("numbers days from the first one, leaving gaps for days with nothing", () => {
    const days = groupByDay(
      [expense("a", at(2026, 8, 14)), expense("b", at(2026, 8, 16))],
      new Date(2026, 7, 20),
    );
    expect(days.map((d) => [d.dayNumber, d.label])).toEqual([
      [1, "8/14"],
      [3, "8/16"],
    ]);
  });

  it("counts across a month end", () => {
    const days = groupByDay(
      [expense("a", at(2026, 8, 31)), expense("b", at(2026, 9, 1))],
      new Date(2026, 8, 1, 18),
    );
    expect(days.map((d) => [d.dayNumber, d.isToday])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("returns nothing for no expenses", () => {
    expect(groupByDay([])).toEqual([]);
  });
});
