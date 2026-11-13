// Turns what the model read off a receipt into the expense sheet's draft, plus
// the questions the person has to answer before it can be saved. Pure, so the
// "ask when unsure" rules are tested without a model or a browser.
//
// Amounts here are major-unit strings, the same form the sheet's inputs hold
// ("45000", "12.50"); arithmetic goes through minor units of the chosen
// currency so a sum never drifts on floating point.

import {
  CURRENCIES,
  formatMoney,
  fromMinor,
  isCurrencyCode,
  toMinor,
  type CurrencyCode,
} from "../engine";
import type { ReceiptReading } from "./reading";

export interface ReceiptContext {
  /** The trip's categories; a reading may only pick one of these ids. */
  categoryIds: string[];
  /** Everyone in the trip. Each line starts shared by all of them. */
  memberIds: string[];
  /** What the sheet would have used anyway; the default when the receipt does not settle it. */
  fallbackCurrency: CurrencyCode;
}

export interface ReceiptLineDraft {
  label: string;
  /** May be negative: a discount line. */
  amount: string;
  personIds: string[];
}

export type ReceiptQuestion =
  | {
      id: string;
      kind: "currency";
      prompt: string;
      options: { label: string; currency: CurrencyCode }[];
    }
  | { id: string; kind: "total"; prompt: string; options: { label: string; amount: string }[] }
  | {
      id: string;
      kind: "line";
      /** Index into `ReceiptDraft.lines`. */
      line: number;
      prompt: string;
      options: { label: string; amount: string }[];
    }
  | { id: string; kind: "doubt"; prompt: string };

export interface ReceiptDraft {
  description: string;
  amount: string;
  currency: CurrencyCode;
  category?: string;
  /** 依項目 when the receipt has lines, otherwise 平分 on the total. */
  mode: "items" | "equal";
  lines: ReceiptLineDraft[];
  questions: ReceiptQuestion[];
}

export type ReceiptResult = { ok: true; draft: ReceiptDraft } | { ok: false; reason: string };

export const UNREADABLE = "看不出這是收據，先手動填吧。";

/** 「繁中 · 原文」, or just one of them when the other is empty or the same. */
export function bilingual(translated: string, original: string): string {
  const zh = translated.trim();
  const raw = original.trim();
  if (!raw || raw === zh) return zh;
  if (!zh) return raw;
  return `${zh} · ${raw}`;
}

function majorString(minor: number, code: CurrencyCode): string {
  return fromMinor(minor, code).toFixed(CURRENCIES[code].decimals);
}

function pickCurrency(
  reading: ReceiptReading,
  fallback: CurrencyCode,
): { currency: CurrencyCode; question?: ReceiptQuestion } {
  const read = reading.currency.code.trim().toUpperCase();
  const candidates = [read, ...reading.currency.alternatives.map((c) => c.trim().toUpperCase())]
    .filter((c, i, all) => c !== "" && all.indexOf(c) === i);
  const supported = candidates.filter(isCurrencyCode);
  const currency = supported[0] ?? fallback;

  const unsupported = read !== "" && !isCurrencyCode(read);
  const settled = reading.currency.confident && candidates.length === 1 && !unsupported;
  if (settled) return { currency };

  const options = supported.length > 0 ? supported : [fallback];
  return {
    currency,
    question: {
      id: "currency",
      kind: "currency",
      prompt: unsupported
        ? `收據看起來是 ${read}，還不支援這個幣別。要用哪個記？`
        : read === ""
          ? "看不出這張收據用哪個幣別，是哪個？"
          : "這張收據用哪個幣別？",
      options: options.map((code) => ({ label: CURRENCIES[code].short, currency: code })),
    },
  };
}

export function readingToDraft(reading: ReceiptReading, ctx: ReceiptContext): ReceiptResult {
  if (!reading.readable) return { ok: false, reason: UNREADABLE };

  const { currency, question: currencyQuestion } = pickCurrency(reading, ctx.fallbackCurrency);
  const money = (minor: number) => formatMoney(minor, currency);

  // Lines: discounts become negative; anything that reads as zero is dropped.
  const lines = reading.lines
    .map((line) => {
      const minor = toMinor(Math.abs(line.amount), currency);
      return {
        label: bilingual(line.translated, line.original),
        minor: line.kind === "discount" ? -minor : minor,
        alternatives: line.amountAlternatives
          .map((alt) => toMinor(Math.abs(alt), currency) * (line.kind === "discount" ? -1 : 1))
          .filter((alt) => alt !== 0 && alt !== minor && alt !== -minor),
      };
    })
    .filter((line) => line.minor !== 0);
  const linesSum = lines.reduce((sum, line) => sum + line.minor, 0);

  // Totals: positive, distinct, in the model's order of likelihood.
  const totals = reading.totals
    .map((t) => ({ label: t.label.trim(), minor: toMinor(t.amount, currency) }))
    .filter((t, i, all) => t.minor > 0 && all.findIndex((o) => o.minor === t.minor) === i);

  const total = totals[0]?.minor ?? (linesSum > 0 ? linesSum : 0);
  if (total <= 0) return { ok: false, reason: UNREADABLE };

  const questions: ReceiptQuestion[] = [];
  if (currencyQuestion) questions.push(currencyQuestion);

  // Our own arithmetic, not the model's: lines that do not reach the total are
  // a question even when the model sounded sure of both. Lines that reach it
  // exactly settle it, so a printed subtotal is not asked about as well.
  const mismatch = lines.length > 0 && linesSum !== total;
  const confirmedByLines = lines.length > 0 && linesSum === total;
  if ((totals.length > 1 && !confirmedByLines) || mismatch) {
    const options = totals.map((t) => ({
      label: t.label ? `${money(t.minor)}（${t.label}）` : money(t.minor),
      amount: majorString(t.minor, currency),
    }));
    if (mismatch && linesSum > 0 && !totals.some((t) => t.minor === linesSum)) {
      options.push({ label: `${money(linesSum)}（明細加總）`, amount: majorString(linesSum, currency) });
    }
    questions.push({
      id: "total",
      kind: "total",
      prompt: mismatch
        ? `明細加起來 ${money(linesSum)}，跟總額 ${money(total)} 差 ${money(Math.abs(total - linesSum))}。總額是哪個？`
        : `收據上有 ${totals.length} 個可能的總額，是哪個？`,
      options,
    });
  }

  lines.forEach((line, i) => {
    if (line.alternatives.length === 0) return;
    questions.push({
      id: `line-${i}`,
      kind: "line",
      line: i,
      prompt: `第 ${i + 1} 項「${line.label || "（沒有名字）"}」金額看不清楚，是哪個？`,
      options: [line.minor, ...line.alternatives].map((minor) => ({
        label: money(minor),
        amount: majorString(minor, currency),
      })),
    });
  });

  reading.doubts
    .map((doubt) => doubt.trim())
    .filter(Boolean)
    .forEach((doubt, i) => questions.push({ id: `doubt-${i}`, kind: "doubt", prompt: doubt }));

  const category =
    reading.categoryConfident &&
    reading.categoryId !== null &&
    ctx.categoryIds.includes(reading.categoryId)
      ? reading.categoryId
      : undefined;

  return {
    ok: true,
    draft: {
      description: bilingual(reading.merchant.translated, reading.merchant.original),
      amount: majorString(total, currency),
      currency,
      category,
      mode: lines.length > 0 ? "items" : "equal",
      lines: lines.map((line) => ({
        label: line.label,
        amount: majorString(line.minor, currency),
        personIds: [...ctx.memberIds],
      })),
      questions,
    },
  };
}
