import { ICONS, type IconName } from "./icons";

/**
 * Decorative by default: every icon here sits next to the word it stands
 * for, so a screen reader should read the word once, not twice.
 */
export function Icon({
  name,
  size = 20,
  alt = "",
}: {
  name: IconName;
  size?: 20 | 24 | 48;
  alt?: string;
}) {
  return <img className="ts-ico" src={ICONS[name]} width={size} height={size} alt={alt} />;
}
