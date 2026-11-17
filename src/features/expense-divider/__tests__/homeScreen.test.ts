import { describe, it, expect } from "vitest";
import {
  homeScreenTip,
  manifestFor,
  withOpenExternalBrowser,
  withoutOpenExternalBrowser,
} from "../homeScreen";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
const IPHONE_LINE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.20.0";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
const ANDROID_LINE = `${ANDROID_CHROME} Line/15.20.0`;

const browser = (userAgent: string, maxTouchPoints = 5, standalone = false) => ({
  userAgent,
  maxTouchPoints,
  standalone,
});

describe("homeScreenTip", () => {
  it("tells iPhone Safari to use 分享 → 加入主畫面", () => {
    expect(homeScreenTip(browser(IPHONE_SAFARI))).toBe("ios");
  });

  it("sends LINE's browser on iPhone to Safari first", () => {
    expect(homeScreenTip(browser(IPHONE_LINE))).toBe("line");
  });

  it("treats an iPad, which reports itself as a Mac, as iOS", () => {
    expect(homeScreenTip(browser(IPAD_AS_MAC, 5))).toBe("ios");
    expect(homeScreenTip(browser(IPAD_AS_MAC, 0))).toBeNull();
  });

  it("shows nothing inside the Home Screen app", () => {
    expect(homeScreenTip(browser(IPHONE_SAFARI, 5, true))).toBeNull();
  });

  it("shows nothing on Android, where Chrome offers its own install", () => {
    expect(homeScreenTip(browser(ANDROID_CHROME))).toBeNull();
    expect(homeScreenTip(browser(ANDROID_LINE))).toBeNull();
  });
});

describe("LINE's openExternalBrowser parameter", () => {
  const trip = "https://seanachan.github.io/trip-debt-calculator/RONVTB";

  it("is added to send the page to Safari", () => {
    expect(withOpenExternalBrowser(trip)).toBe(`${trip}?openExternalBrowser=1`);
  });

  it("is stripped on arrival, keeping anything else in the address", () => {
    expect(withoutOpenExternalBrowser(`${trip}?openExternalBrowser=1`)).toBe(trip);
    expect(withoutOpenExternalBrowser(`${trip}?a=1&openExternalBrowser=1#x`)).toBe(`${trip}?a=1#x`);
  });

  it("leaves an address without it alone", () => {
    expect(withoutOpenExternalBrowser(trip)).toBeNull();
  });
});

describe("manifestFor", () => {
  it("gives iOS the manifest without start_url, so the icon opens its own trip", () => {
    expect(manifestFor(browser(IPHONE_SAFARI))).toBe("manifest.webmanifest");
    expect(manifestFor(browser(IPAD_AS_MAC, 5))).toBe("manifest.webmanifest");
  });

  it("gives Chrome the one it can install", () => {
    expect(manifestFor(browser(ANDROID_CHROME))).toBe("manifest-chrome.webmanifest");
    expect(manifestFor(browser(IPAD_AS_MAC, 0))).toBe("manifest-chrome.webmanifest");
  });
});
