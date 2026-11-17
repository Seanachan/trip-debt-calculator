// The 「加到主畫面」 tip: which one a browser gets, and the LINE hop to Safari.
// Pure, with the browser's facts passed in, so every case is unit-tested.
// See docs/specs/join-and-home-screen.md.

/** LINE's own query parameter: a link carrying it opens in the phone's default browser. */
export const OPEN_EXTERNAL_PARAM = "openExternalBrowser";

/**
 * - `ios`: Safari or another iOS browser; add through 分享 → 加入主畫面.
 * - `line`: LINE's in-app browser, which cannot add to the Home Screen; go to Safari first.
 * - `null`: nothing to show (already the Home Screen app, Android, desktop).
 */
export type HomeScreenTip = "ios" | "line" | null;

export interface BrowserFacts {
  userAgent: string;
  /** iPadOS Safari reports itself as a Mac; touch points tell them apart. */
  maxTouchPoints: number;
  /** Running as the Home Screen app already. */
  standalone: boolean;
}

function isIOS({ userAgent, maxTouchPoints }: BrowserFacts): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/**
 * Which manifest this browser gets. iOS: no `start_url`, so the icon opens the
 * trip it was added from (a Home Screen app starts with empty storage, so `./`
 * would land on an empty trip list). Everyone else: Chrome will not install
 * without a `start_url`, and an installed app there shares the browser's
 * storage, so `./` resumes the last trip.
 */
export function manifestFor(facts: BrowserFacts): "manifest.webmanifest" | "manifest-chrome.webmanifest" {
  return isIOS(facts) ? "manifest.webmanifest" : "manifest-chrome.webmanifest";
}

export function homeScreenTip(facts: BrowserFacts): HomeScreenTip {
  if (facts.standalone || !isIOS(facts)) return null;
  return /\bLine\//i.test(facts.userAgent) ? "line" : "ios";
}

/** The same page, asking LINE to open it in Safari. */
export function withOpenExternalBrowser(href: string): string {
  const url = new URL(href);
  url.searchParams.set(OPEN_EXTERNAL_PARAM, "1");
  return url.toString();
}

/**
 * The address without LINE's parameter, or null when it has none. Stripped on
 * load so the parameter never ends up in a Home Screen icon or a shared link.
 */
export function withoutOpenExternalBrowser(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(OPEN_EXTERNAL_PARAM)) return null;
  url.searchParams.delete(OPEN_EXTERNAL_PARAM);
  return url.toString();
}

/** This browser's facts. Only call in the browser. */
export function currentBrowser(): BrowserFacts {
  const nav = navigator as Navigator & { standalone?: boolean };
  let standalone = nav.standalone === true;
  try {
    standalone ||= window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    // No matchMedia: not the Home Screen app.
  }
  return { userAgent: nav.userAgent, maxTouchPoints: nav.maxTouchPoints ?? 0, standalone };
}
