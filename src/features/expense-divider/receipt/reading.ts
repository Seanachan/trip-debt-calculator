// What the model returns for a receipt photo. Parsed with zod before anything
// uses it: the model's JSON is input, not truth. The Gemini `responseSchema`
// in scan.ts mirrors this shape; keep the two in step.

import { z } from "zod";

export const LINE_KINDS = ["item", "tax", "service", "tip", "discount"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/** A name as the app shows it (繁中) and as printed. `original` is "" when the receipt is in Chinese. */
const nameSchema = z.object({
  translated: z.string().default(""),
  original: z.string().default(""),
});

export const receiptReadingSchema = z.object({
  /** False when the photo is not a receipt, or nothing on it can be read. */
  readable: z.boolean(),
  merchant: nameSchema.default({ translated: "", original: "" }),
  currency: z
    .object({
      /** ISO 4217, as the model reads it. May be one the app does not support. */
      code: z.string().default(""),
      alternatives: z.array(z.string()).default([]),
      confident: z.boolean().default(false),
    })
    .default({ code: "", alternatives: [], confident: false }),
  /** Every amount that could be "the total", most likely first, in major units as printed. */
  totals: z.array(z.object({ label: z.string().default(""), amount: z.number() })).default([]),
  lines: z
    .array(
      nameSchema.extend({
        /** Positive as printed, in major units; a discount is positive with kind "discount". */
        amount: z.number(),
        kind: z.enum(LINE_KINDS).catch("item"),
        /** Other readings of a hard-to-read amount; empty when it is clear. */
        amountAlternatives: z.array(z.number()).default([]),
      }),
    )
    .default([]),
  categoryId: z.string().nullable().default(null),
  categoryConfident: z.boolean().default(false),
  /** Anything else the model is unsure of, each a short question in 繁中. */
  doubts: z.array(z.string()).default([]),
});

export type ReceiptReading = z.infer<typeof receiptReadingSchema>;
