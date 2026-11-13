# Receipt scan (拍收據)

Take a photo of a receipt in 記一筆 and get the sheet filled in: amount, currency, what it was, and one
依項目 line per item. The model reads; the person decides. Anything the model is unsure of, and
anything a receipt cannot say (who paid, who shared what), stays a question until the person answers it.

Decided with the user on 2026-11-13. The UI it plugs into is in [ledger-sticker-ui.md](ledger-sticker-ui.md).

## Decisions

| | Decision |
|---|---|
| Model | Gemini through **Firebase AI Logic**, Gemini Developer API, free tier. No Claude API: the user has no API account, and AI Logic needs no server or key of our own, which matters on a static GitHub Pages site. Model id lives in one constant (`RECEIPT_MODEL`): **`gemini-3.5-flash-lite`**, thinking level LOW, 45 s timeout. The plan was `gemini-3.8-flash`, but on 2026-11-13 its free tier failed three test scans in a row (one ran past two minutes, then "high demand"); flash-lite read the same Korean test receipt correctly in 7 s. |
| Entry | 「拍收據」 at the top of 記一筆, **only when adding**. Editing an existing expense never shows it, so one tap cannot overwrite what is there. The file picker offers camera or library (`accept="image/*"`, no `capture`). |
| Photo | Converted on the device to JPEG, long edge ≤ 1536 px, then sent inline. Never uploaded to Firebase, never stored with the expense; dropped once read. HEIC is not accepted by the API, so re-encoding is required, not just a size saving. |
| Privacy | Before the first scan on a device, a notice says the photo goes to Google Gemini and that on the free tier Google may use it to improve its products, including human review. Scanning continues only after 「知道了」. Remembered per device. |
| Filled in | Amount, currency, description (merchant), category, and one line per receipt line. Names read 「繁中 · 原文」 (「星巴克 · 스타벅스」); a receipt already in Chinese is not repeated. |
| Date | Ignored. Expenses still group by when they were logged; a `spentAt` field is a later change. |
| Split | **依項目** by default, every line shared by everyone; tap people off. Tax, service charge, tip and discount are each their own line, shared by everyone. No readable lines → 平分 on the total. |
| Payer | Whoever scans, as in a manual 記一筆; changeable in 誰付的. |
| Category | Only from the trip's own categories, and only when the model is confident. Otherwise left empty, with no question: category is optional. |
| Failure | No network, quota used up, or not a readable receipt → one line above the form saying why; the form stays empty for manual entry. No automatic retry. |
| Abuse | **App Check** with reCAPTCHA Enterprise, required by AI Logic since 2026-11-02. Initialised lazily on the first scan, so the 10,000 free assessments a month are only spent by people who scan. Enforced on AI Logic only; Firestore is untouched. |

## Asking when unsure

The model's answer is input, not truth: it is parsed with zod and checked by our own code before anything
reaches the sheet. A question appears next to the field it is about, with tappable answers plus 「我自己改」.
**Save stays off while any question is open**, next to the existing 分好了！ gate. Editing the field a question
is about counts as answering it.

| Raised when | Question | Answers |
|---|---|---|
| Currency symbol fits more than one currency, the model is not confident, or the currency is not one we support (e.g. ¥ could be JPY or CNY; CNY is unsupported) | 「這張收據用哪個幣別？」 | Each supported candidate, then 我自己改 |
| The lines do not add up to the total (checked by our code, not the model), **or** there are several plausible totals and no lines to settle it. Lines that add up exactly to the first total settle it, so a printed subtotal is not asked about | 「總額是哪個？」 with what disagrees | Each candidate, the lines' sum if different, then 我自己改 |
| A line's amount is hard to read | 「第 n 項「…」金額看不清」 | The model's readings, then 我自己改 |
| Any other doubt the model reports (a smudged name, a handwritten tip) | The doubt, verbatim | 知道了 |

Who paid and who shared each line are never asked as questions: they have visible defaults (the scanner;
everyone) and are part of the normal sheet.

## Storage

Nothing new is stored. A scanned expense is an ordinary 依項目 expense (`method: "exact"` + `split.items`).

One engine change: **a line may be negative**, for discounts. Line amounts must be non-zero integers, lines
still sum to the expense amount, and every person's total must still be ≥ 0 (the existing exact-split rule),
so a discount can never leave someone being paid for eating. A scanned discount arrives as a negative line
and the field keeps its leading 「-」. Typing one by hand needs a keyboard with a minus key, which the
iPhone decimal pad lacks; manual discounts are rare enough to leave that for now. Builds before this one
ignore `items` when reading, so they are unaffected.

## Model contract

`src/features/expense-divider/receipt/reading.ts` holds the zod schema for what the model returns; the
Gemini `responseSchema` in `scan.ts` mirrors it. In short:

- `readable` — false when the photo is not a receipt or cannot be read.
- `merchant` — `{ translated, original }`.
- `currency` — `{ code, alternatives[], confident }`, ISO 4217.
- `totals[]` — candidate totals as printed, most likely first.
- `lines[]` — `{ translated, original, amount, kind, amountAlternatives[] }`, where `kind` is
  item / tax / service / tip / discount and `amount` is positive as printed.
- `categoryId` + `categoryConfident`.
- `doubts[]` — anything else it is unsure of, in 繁中.

`receipt/draft.ts` turns that into the sheet's draft plus the open questions. It is pure and unit-tested;
everything that talks to Firebase is in `receipt/scan.ts`.

## Tested against

Five rendered receipts through the real flow (App Check → AI Logic → `gemini-3.5-flash-lite`), 2026-11-13.
Re-run them after any change to the instructions in `scan.ts`.

| Receipt | What it probes | Result |
|---|---|---|
| 7-Eleven, Tokyo | Tax already inside the prices (内消費税); cash handed over and change printed | First run listed the included tax as two lines and offered お預り/お釣り as totals; our sum caught the ¥55 gap and asked. Instructions now exclude both; second run correct with no question |
| Diner, Portland | `$`, tip handwritten | USD, four lines including the tip, no question |
| FamilyMart, Taipei | Chinese receipt; `1x35` notation | TWD, names not repeated; notation dropped after the instruction change |
| Café, Seoul, tilted, blurred, one amount smudged | Hard read | All amounts right; no question, because the lines add up exactly to the printed total |
| A sticky note | Not a receipt | 「看不出這是收據」, form left empty |

Not yet tried: a real phone photo (crumpled paper, glare, long supermarket receipt).

## Setup (once, by the project owner)

1. Firebase console → AI Services → AI Logic → Get started → **Gemini Developer API**.
2. Google Cloud console → reCAPTCHA (Fraud Defense) → enable the API if asked → create a **Web** key for
   `seanachan.github.io`, checkbox challenge off. Do not add `localhost`.
3. Firebase console → App Check → Apps → register the web app with **reCAPTCHA Enterprise** and that key.
4. App Check → APIs → Firebase AI Logic → **Enforce**.
5. Put the key in `.env.local` and in a repository secret, both named `VITE_RECAPTCHA_ENTERPRISE_KEY`.
   Without it the 「拍收據」 button is hidden, so builds without the secret behave exactly as before.
6. Local dev: `yarn dev` prints an App Check debug token in the browser console on the first scan.
   Register it under App Check → Apps → ⋮ → Manage debug tokens.

## Not done

- Receipt date → expense date (needs a `spentAt` field and day grouping by it).
- Several receipts at once; one photo is one expense.
- Spreading tax or service charge in proportion to each person's lines.
- Keeping the photo with the expense (would need Cloud Storage, which needs the Blaze plan).
