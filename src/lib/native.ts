import { Capacitor } from "@capacitor/core";

/**
 * One-time native shell setup, only on a real device. Dynamic-imports the native plugins so
 * the web build never pulls them at runtime.
 *  - Status bar: light glyphs (Style.Dark) so the clock/battery are readable on the dark
 *    graphite header the WebView draws under (contentInset: "never").
 *  - Keyboard: hide the prev/next/done accessory bar for a cleaner sheet; resizing is handled
 *    natively via capacitor.config Keyboard.resize = "native".
 */
export async function initNative(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
  } catch { /* non-fatal */ }
  try {
    const { Keyboard } = await import("@capacitor/keyboard");
    await Keyboard.setAccessoryBarVisible({ isVisible: false });
  } catch { /* non-fatal */ }
}
