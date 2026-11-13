import bag from "../assets/icons/bag.svg";
import bed from "../assets/icons/bed.svg";
import bowl from "../assets/icons/bowl.svg";
import buddy from "../assets/icons/buddy.svg";
import bus from "../assets/icons/bus.svg";
import camera from "../assets/icons/camera.svg";
import check from "../assets/icons/check.svg";
import coin from "../assets/icons/coin.svg";
import type { Category } from "../features/expense-divider/engine";

/** The design system's sticker icons, drawn on a 48×48 grid. */
export const ICONS = { bag, bed, bowl, buddy, bus, camera, check, coin } as const;

export type IconName = keyof typeof ICONS;

/** Which `--cat-*` fill a category's bubble sits on. `plain` is `panel-tint`. */
export type CategoryFill = "transit" | "stay" | "food" | "sight" | "shop" | "plain";

export type CategoryLook =
  | { kind: "icon"; icon: IconName; fill: CategoryFill }
  | { kind: "emoji"; emoji: string; fill: "plain" };

/**
 * Sticker icons for the ids `DEFAULT_CATEGORIES` seeds, plus 未分類. Keyed by
 * id, not label, so a trip that renames 餐飲 keeps the bowl.
 */
const BUILT_IN: Record<string, { icon: IconName; fill: CategoryFill }> = {
  food: { icon: "bowl", fill: "food" },
  stay: { icon: "bed", fill: "stay" },
  transit: { icon: "bus", fill: "transit" },
  fun: { icon: "camera", fill: "sight" },
  shopping: { icon: "bag", fill: "shop" },
  other: { icon: "coin", fill: "plain" },
  __none: { icon: "coin", fill: "plain" },
};

export function isBuiltInCategory(id: string): boolean {
  return id in BUILT_IN;
}

/**
 * A category the group made itself keeps the emoji it was given: that emoji is
 * the group's own content, the way a trip's flag is, not UI chrome.
 */
export function categoryLook(category: Category | undefined): CategoryLook {
  if (!category) return { kind: "icon", ...BUILT_IN.__none };
  const builtIn = BUILT_IN[category.id];
  return builtIn ? { kind: "icon", ...builtIn } : { kind: "emoji", emoji: category.icon, fill: "plain" };
}
