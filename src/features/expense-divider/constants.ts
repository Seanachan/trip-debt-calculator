// Shared UI-facing constants for the expense-divider feature: member color
// palette, expense icon set, and a re-export of the currency table so the
// UI layer has one import path for all three.

// Member fills, drawn from painted Tainan surfaces: aged grille mint, tile
// glazes, brick wash, signboard cream. All light enough to carry an ink
// initial (see .tdt-avatar).
export const PALETTE = [
  "#9cc4b2", // 鐵窗綠 · sun-bleached
  "#e8c9bf", // 磚紅 wash
  "#e2d3b3", // 招牌米 · shaded
  "#a9c4cd", // 洗石子 blue-grey
  "#cbb98f", // 老木
  "#c3cf9f", // 門框綠
  "#e6b9a1", // 陶
  "#bdb2cc", // 廟牆紫
];

export const ICONS = [
  "🍽️",
  "🏨",
  "🚕",
  "🛵",
  "⛵",
  "🛒",
  "🍹",
  "🎟️",
  "☕",
  "🏖️",
  "⛽",
  "🎁",
];

/** Emoji offered when a group names its own spend category. */
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
