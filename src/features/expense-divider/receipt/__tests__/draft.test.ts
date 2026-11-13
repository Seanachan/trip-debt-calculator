import { describe, it, expect } from "vitest";
import { bilingual, readingToDraft, UNREADABLE, type ReceiptContext } from "../draft";
import { receiptReadingSchema, type ReceiptReading } from "../reading";

const ctx: ReceiptContext = {
  categoryIds: ["food", "stay", "transit"],
  memberIds: ["me", "k", "m"],
  fallbackCurrency: "KRW",
};

/** A clean Korean BBQ receipt, overridable per test. Goes through the zod schema like a real reply. */
function reading(overrides: Partial<Record<keyof ReceiptReading, unknown>> = {}): ReceiptReading {
  return receiptReadingSchema.parse({
    readable: true,
    merchant: { translated: "明洞烤肉", original: "명동고기" },
    currency: { code: "KRW", alternatives: [], confident: true },
    totals: [{ label: "合計", amount: 45000 }],
    lines: [
      { translated: "五花肉", original: "삼겹살", amount: 30000, kind: "item" },
      { translated: "冷麵", original: "냉면", amount: 12000, kind: "item" },
      { translated: "燒酒", original: "소주", amount: 5000, kind: "item" },
      { translated: "折扣", original: "할인", amount: 2000, kind: "discount" },
    ],
    categoryId: "food",
    categoryConfident: true,
    doubts: [],
    ...overrides,
  });
}

function draftOf(r: ReceiptReading) {
  const result = readingToDraft(r, ctx);
  if (!result.ok) throw new Error(`expected a draft, got: ${result.reason}`);
  return result.draft;
}

describe("readingToDraft", () => {
  it("fills a clear receipt in without asking anything", () => {
    const draft = draftOf(reading());
    expect(draft).toMatchObject({
      description: "明洞烤肉 · 명동고기",
      amount: "45000",
      currency: "KRW",
      category: "food",
      mode: "items",
      questions: [],
    });
    expect(draft.lines.map((l) => [l.label, l.amount])).toEqual([
      ["五花肉 · 삼겹살", "30000"],
      ["冷麵 · 냉면", "12000"],
      ["燒酒 · 소주", "5000"],
      ["折扣 · 할인", "-2000"],
    ]);
  });

  it("starts every line shared by everyone", () => {
    for (const line of draftOf(reading()).lines) {
      expect(line.personIds).toEqual(["me", "k", "m"]);
    }
  });

  it("asks for the total when the lines do not add up, checked by our own sum", () => {
    // Without the discount the lines reach 47000, not the 45000 on the receipt.
    const r = reading({
      lines: [
        { translated: "五花肉", original: "", amount: 30000, kind: "item" },
        { translated: "冷麵", original: "", amount: 12000, kind: "item" },
        { translated: "燒酒", original: "", amount: 5000, kind: "item" },
      ],
    });
    const draft = draftOf(r);
    expect(draft.amount).toBe("45000");
    expect(draft.questions).toEqual([
      {
        id: "total",
        kind: "total",
        prompt: "明細加起來 ₩47,000，跟總額 ₩45,000 差 ₩2,000。總額是哪個？",
        options: [
          { label: "₩45,000（合計）", amount: "45000" },
          { label: "₩47,000（明細加總）", amount: "47000" },
        ],
      },
    ]);
  });

  it("asks which total when the receipt shows more than one", () => {
    const draft = draftOf(
      reading({
        totals: [
          { label: "含服務費", amount: 49500 },
          { label: "小計", amount: 45000 },
        ],
        lines: [],
      }),
    );
    expect(draft.mode).toBe("equal");
    expect(draft.amount).toBe("49500");
    expect(draft.questions[0]).toMatchObject({
      kind: "total",
      prompt: "收據上有 2 個可能的總額，是哪個？",
      options: [
        { label: "₩49,500（含服務費）", amount: "49500" },
        { label: "₩45,000（小計）", amount: "45000" },
      ],
    });
  });

  it("does not ask about a subtotal when the lines add up to the first total", () => {
    // What gemini returned for a real test receipt: 合計, 小計 and 實付 all listed.
    const draft = draftOf(
      reading({
        totals: [
          { label: "合計", amount: 45000 },
          { label: "小計", amount: 47000 },
        ],
      }),
    );
    expect(draft.questions).toEqual([]);
  });

  it("still asks when the lines match a total other than the first", () => {
    const draft = draftOf(
      reading({
        totals: [
          { label: "含服務費", amount: 49500 },
          { label: "小計", amount: 45000 },
        ],
      }),
    );
    expect(draft.questions[0]).toMatchObject({ kind: "total" });
  });

  it("asks about a bare ¥ even when the model leans one way", () => {
    const draft = draftOf(
      reading({
        currency: { code: "JPY", alternatives: ["CNY"], confident: false },
        totals: [{ label: "合計", amount: 1200 }],
        lines: [],
      }),
    );
    expect(draft.currency).toBe("JPY");
    expect(draft.questions[0]).toEqual({
      id: "currency",
      kind: "currency",
      prompt: "這張收據用哪個幣別？",
      // CNY is not supported, so it is not offered; 我自己改 covers it in the UI.
      options: [{ label: "JPY ¥", currency: "JPY" }],
    });
  });

  it("asks when the currency is one the app does not support, defaulting to the sheet's", () => {
    const draft = draftOf(
      reading({ currency: { code: "cny", alternatives: [], confident: true }, lines: [] }),
    );
    expect(draft.currency).toBe("KRW");
    expect(draft.questions[0]).toMatchObject({
      kind: "currency",
      prompt: "收據看起來是 CNY，還不支援這個幣別。要用哪個記？",
      options: [{ currency: "KRW" }],
    });
  });

  it("asks about a hard-to-read line amount, keeping the best reading meanwhile", () => {
    const r = reading();
    r.lines[1].amountAlternatives = [17000];
    r.totals = [{ label: "合計", amount: 45000 }];
    const draft = draftOf(r);
    expect(draft.lines[1].amount).toBe("12000");
    expect(draft.questions).toContainEqual({
      id: "line-1",
      kind: "line",
      line: 1,
      prompt: "第 2 項「冷麵 · 냉면」金額看不清楚，是哪個？",
      options: [
        { label: "₩12,000", amount: "12000" },
        { label: "₩17,000", amount: "17000" },
      ],
    });
  });

  it("turns each reported doubt into a question", () => {
    const draft = draftOf(reading({ doubts: ["店名第一個字看不清楚", "  "] }));
    expect(draft.questions).toEqual([{ id: "doubt-0", kind: "doubt", prompt: "店名第一個字看不清楚" }]);
  });

  it("only sets a category the trip has and the model is sure of", () => {
    expect(draftOf(reading({ categoryConfident: false })).category).toBeUndefined();
    expect(draftOf(reading({ categoryId: "spa" })).category).toBeUndefined();
  });

  it("keeps the currency's decimals in the amounts it fills in", () => {
    const draft = draftOf(
      reading({
        currency: { code: "USD", alternatives: [], confident: true },
        totals: [{ label: "Total", amount: 12.5 }],
        lines: [{ translated: "咖啡", original: "Coffee", amount: 12.5, kind: "item" }],
      }),
    );
    expect(draft.amount).toBe("12.50");
    expect(draft.lines[0].amount).toBe("12.50");
  });

  it("falls back to the lines' sum when no total was read", () => {
    expect(draftOf(reading({ totals: [] })).amount).toBe("45000");
  });

  it("gives up on an unreadable photo, or one with no amount at all", () => {
    expect(readingToDraft(reading({ readable: false }), ctx)).toEqual({ ok: false, reason: UNREADABLE });
    expect(readingToDraft(reading({ totals: [], lines: [] }), ctx)).toEqual({
      ok: false,
      reason: UNREADABLE,
    });
  });
});

describe("bilingual", () => {
  it("joins translation and original, and does not repeat a Chinese receipt", () => {
    expect(bilingual("星巴克", "스타벅스")).toBe("星巴克 · 스타벅스");
    expect(bilingual("全家", "全家")).toBe("全家");
    expect(bilingual("全家", "")).toBe("全家");
    expect(bilingual("", "FamilyMart")).toBe("FamilyMart");
  });
});
