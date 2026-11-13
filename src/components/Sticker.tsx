// Presentational pieces of the 行程表 design system that the ledger repeats:
// the taped box, buddy chips, the overlapping badge row and the category
// bubble. No state, no data fetching — the page owns all of that.

import type { ReactNode } from "react";
import type { Category } from "../features/expense-divider/engine";
import { Icon } from "./Icon";
import { categoryLook, type IconName } from "./icons";

/** InfoBox: a labelled sticker panel with washi tape on its corner. */
export function Box({
  label,
  icon,
  aside,
  labelId,
  className = "",
  children,
}: {
  label: ReactNode;
  icon?: IconName;
  aside?: ReactNode;
  labelId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`ts-box ts-sticker ${className}`} aria-labelledby={labelId}>
      <h2 className="ts-label" id={labelId}>
        <span className="ts-tape" aria-hidden />
        {icon && <Icon name={icon} />}
        {label}
        {aside !== undefined && <span className="ts-label__aside">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

export interface BuddyFace {
  /** What the chip says: the member's name, or 你 for this device. */
  name: string;
  /** The one character on the round badge. */
  char: string;
}

export function Buddy({ face }: { face: BuddyFace }) {
  return (
    <span className="ts-buddy ts-soft">
      <span className="ts-av" aria-hidden>
        {face.char}
      </span>
      <span className="ts-buddy__name">{face.name}</span>
    </span>
  );
}

/** A buddy you can pick: pressed turns sky. */
export function BuddyToggle({
  face,
  pressed,
  onClick,
}: {
  face: BuddyFace;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="ts-buddy ts-soft" aria-pressed={pressed} onClick={onClick}>
      <span className="ts-av" aria-hidden>
        {face.char}
      </span>
      <span className="ts-buddy__name">{face.name}</span>
    </button>
  );
}

/** The compact 「誰分」 line: overlapping badges, names for screen readers. */
export function Avatars({ faces, max = 5 }: { faces: BuddyFace[]; max?: number }) {
  const shown = faces.length > max ? faces.slice(0, max - 1) : faces;
  const hidden = faces.length - shown.length;
  const names = faces.map((f) => f.name).join("、");
  return (
    <span className="ts-avs" role="img" aria-label={`${names} 分`} title={names}>
      {shown.map((f, i) => (
        <span className="ts-av" key={`${f.name}-${i}`}>
          {f.char}
        </span>
      ))}
      {hidden > 0 && <span className="ts-av ts-av--more">+{hidden}</span>}
    </span>
  );
}

/** A category's round bubble: its sticker icon on its fill, or its own emoji. */
export function CategoryTile({
  category,
  size = 24,
  labelled = false,
}: {
  category: Category | undefined;
  size?: 20 | 24;
  /** Say the category's name to screen readers, for rows that don't print it. */
  labelled?: boolean;
}) {
  const look = categoryLook(category);
  const alt = labelled ? (category?.label ?? "未分類") : "";
  return (
    <span className={`ts-tile ts-tile--${look.fill} ts-soft`}>
      {look.kind === "icon" ? (
        <Icon name={look.icon} size={size} alt={alt} />
      ) : (
        <span role={labelled ? "img" : undefined} aria-label={labelled ? alt : undefined} aria-hidden={!labelled}>
          {look.emoji}
        </span>
      )}
    </span>
  );
}

/** The 20px icon a category chip leads with. */
export function CategoryMark({ category }: { category: Category }) {
  const look = categoryLook(category);
  return look.kind === "icon" ? (
    <Icon name={look.icon} />
  ) : (
    <span className="ts-chip__emoji" aria-hidden>
      {look.emoji}
    </span>
  );
}
