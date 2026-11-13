// Reads a receipt photo with Gemini through Firebase AI Logic. The only module
// here that talks to the network; the page imports it on demand, so neither
// the AI SDK nor App Check is loaded until someone taps 拍收據.
//
// The model's answer is parsed with zod (reading.ts) before it is returned;
// what to do with it, and what to ask about, is decided in draft.ts.

import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import {
  AIError,
  AIErrorCode,
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  Schema,
  ThinkingLevel,
  type GenerativeModel,
} from "firebase/ai";
import { app, recaptchaEnterpriseKey } from "../firebase/config";
import { ReceiptScanError } from "./errors";
import type { PreparedImage } from "./image";
import { LINE_KINDS, receiptReadingSchema, type ReceiptReading } from "./reading";

/**
 * Free tier of the Gemini Developer API. `gemini-3.5-flash-lite` is the cheaper
 * fallback if the project's daily free quota turns out too small.
 */
export const RECEIPT_MODEL = "gemini-3.5-flash-lite";

/**
 * Past this the person is better off typing it in. The SDK's default is three
 * minutes, and on the free tier a slow model really does take that long.
 */
const SCAN_TIMEOUT_MS = 45_000;

const INSTRUCTIONS = `You read photos of shop and restaurant receipts for an expense-splitting app used by travellers from Taiwan.
Report only what the receipt shows. Never invent or guess a value: when unsure, say so in the fields made for it.

- readable: false if the photo is not a receipt or nothing on it can be read; then leave every other field empty.
- merchant.translated: a short shop name in Traditional Chinese as used in Taiwan (스타벅스 → 星巴克). merchant.original: the name as printed. If the receipt is already in Chinese, original is "".
- currency.code: the ISO 4217 code the amounts are in. confident: true only when the receipt makes it unambiguous (a currency code, the country, the language). A bare "¥" or "$" is ambiguous: list every plausible code in alternatives and set confident to false. The hint about recent currencies may order the candidates but never makes you confident.
- totals: every amount that could be what was charged (subtotal, total with or without service), most likely first, each with a short Traditional Chinese label such as 合計, 小計, 含服務費. Never the cash handed over (お預り, 現金, Cash, Tendered) or the change (お釣り, 找零, Change). Amounts exactly as printed, in major units (12.50, not 1250).
- lines: one per purchased line, in printed order. Tax, service charge, tip and discount are their own lines, with that kind, but only when they are added on top of the items. Tax that is already inside the prices (内消費税, 内税, 含稅, incl. VAT, "of which tax") is not a line. translated and original as for the merchant, without the quantity × unit price notation ("大杯拿鐵 1x55" is 大杯拿鐵; a count such as ×2 may stay). amount: the line's total (quantity × unit price), positive, as printed; a discount is positive with kind "discount". If an amount is hard to read, give your best reading in amount and the other possible readings in amountAlternatives; otherwise amountAlternatives is empty.
- Leave out lines that only restate a total or subtotal, cash handed over, change, payment method or card details.
- categoryId: one of the given category ids if the receipt clearly belongs to it, otherwise null. categoryConfident: true only when it is obvious.
- doubts: anything else you are unsure of, each one short question in Traditional Chinese, such as 店名第一個字看不清楚，是「明」嗎？ Leave it empty when nothing is unclear.`;

const name = { translated: Schema.string(), original: Schema.string() };

const RESPONSE_SCHEMA = Schema.object({
  properties: {
    readable: Schema.boolean(),
    merchant: Schema.object({ properties: name }),
    currency: Schema.object({
      properties: {
        code: Schema.string(),
        alternatives: Schema.array({ items: Schema.string() }),
        confident: Schema.boolean(),
      },
    }),
    totals: Schema.array({
      items: Schema.object({ properties: { label: Schema.string(), amount: Schema.number() } }),
    }),
    lines: Schema.array({
      items: Schema.object({
        properties: {
          ...name,
          amount: Schema.number(),
          kind: Schema.enumString({ enum: [...LINE_KINDS] }),
          amountAlternatives: Schema.array({ items: Schema.number() }),
        },
      }),
    }),
    categoryId: Schema.string({ nullable: true }),
    categoryConfident: Schema.boolean(),
    doubts: Schema.array({ items: Schema.string() }),
  },
});

let model: GenerativeModel | undefined;

function receiptModel(): GenerativeModel {
  if (model) return model;
  if (!app || !recaptchaEnterpriseKey) {
    throw new ReceiptScanError("收據辨識還沒設定好，先手動填吧。");
  }
  if (import.meta.env.DEV) {
    // localhost cannot pass reCAPTCHA, so dev uses a debug token: the one in
    // .env.local if set (already registered under App Check → Apps → Manage
    // debug tokens), otherwise `true`, which prints a fresh one to register.
    // Dead code in a production build, so no token reaches the bundle.
    const debugToken: string | undefined = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN;
    (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      debugToken || true;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(recaptchaEnterpriseKey),
    // A token is fetched when a scan needs one. Refreshing in the background
    // would spend the 10,000 free assessments a month on idle tabs.
    isTokenAutoRefreshEnabled: false,
  });
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  model = getGenerativeModel(
    ai,
    {
      model: RECEIPT_MODEL,
      systemInstruction: INSTRUCTIONS,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        // Reading a receipt is transcription plus a little judgement; the
        // default dynamic thinking made a single receipt run past two minutes.
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    },
    { timeout: SCAN_TIMEOUT_MS },
  );
  return model;
}

export interface ScanHints {
  categories: { id: string; label: string }[];
  /** What the trip has been spending in, most recent first. Orders candidates; never settles them. */
  recentCurrencies: string[];
}

export async function readReceipt(image: PreparedImage, hints: ScanHints): Promise<ReceiptReading> {
  const request = [
    `Categories: ${JSON.stringify(hints.categories)}`,
    `Recent currencies: ${hints.recentCurrencies.join(", ") || "none"}`,
    "Read this receipt.",
  ].join("\n");

  let text: string;
  try {
    const result = await receiptModel().generateContent([
      request,
      { inlineData: { data: image.data, mimeType: image.mimeType } },
    ]);
    text = result.response.text();
  } catch (err) {
    if (err instanceof ReceiptScanError) throw err;
    // The person sees one line of 繁中; the cause is only worth printing in dev.
    if (import.meta.env.DEV) console.error("receipt scan failed", err);
    throw new ReceiptScanError(failureMessage(err));
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReceiptScanError("辨識結果看不懂，先手動填吧。");
  }
  const parsed = receiptReadingSchema.safeParse(json);
  if (!parsed.success) throw new ReceiptScanError("辨識結果看不懂，先手動填吧。");
  return parsed.data;
}

function failureMessage(err: unknown): string {
  if (typeof navigator !== "undefined" && !navigator.onLine) return "沒有網路，先手動填吧。";
  if (err instanceof AIError) {
    const status = err.customErrorData?.status;
    if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(err.message)) {
      return "今天的辨識次數用完了，先手動填吧。";
    }
    if (err.code === AIErrorCode.API_NOT_ENABLED) return "收據辨識還沒設定好，先手動填吧。";
    if (status === 401 || status === 403 || /app.?check/i.test(err.message)) {
      return "這台裝置沒通過驗證，先手動填吧。";
    }
    if (/high demand|overloaded/i.test(err.message)) {
      return "辨識服務現在太忙，等一下再試，或先手動填。";
    }
    if (status === 503 || status === 504 || /abort|timeout|deadline/i.test(err.message)) {
      return "辨識太久了，等一下再試，或先手動填。";
    }
  }
  return "讀收據失敗，先手動填吧。";
}
