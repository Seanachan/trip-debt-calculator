// Shared UI-facing constants for the expense-divider feature: member color
// palette, the custom-category emoji set, and a re-export of the currency
// table so the UI layer has one import path for all three.

// Member swatches, still written to each new member's `color`. The sticker UI
// does not show them — every badge sits on `sun` and buddies are told apart by
// name — but older builds still read the field.
export const PALETTE = [
  "#9cc4b2",
  "#e8c9bf",
  "#e2d3b3",
  "#a9c4cd",
  "#cbb98f",
  "#c3cf9f",
  "#e6b9a1",
  "#bdb2cc",
];

/**
 * Emoji offered when a group names its own spend category. The seeded ones
 * show sticker icons instead (see `components/icons.ts`); a group's own keeps
 * the emoji it picked here, because that is the group's content, not chrome.
 */
export const CATEGORY_ICONS = [
  "🍽️",
  "🏨",
  "🚕",
  "🎟️",
  "🛒",
  "📦",
  "☕",
  "🍹",
  "🏖️",
  "⛽",
  "🎁",
  "💊",
  "🧺",
  "📶",
  "🎫",
  "🛶",
];

export { CURRENCIES, CURRENCY_CODES } from "./engine/currency";
export type { CurrencyCode, CurrencyMeta } from "./engine/currency";
