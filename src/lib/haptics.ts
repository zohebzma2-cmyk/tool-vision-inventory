import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

// Haptics are the single biggest "this feels native" signal on iOS. Every meaningful
// touch — tab change, button press, toggle, success, error — gets a matching tap.
// No-ops on web so calls are safe everywhere.
const on = Capacitor.isNativePlatform();

export const haptic = {
  /** Light tick — tab switches, selection, small taps. */
  light: () => on && Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}),
  /** Medium — primary button presses, opening a sheet. */
  medium: () => on && Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}),
  /** Heavy — destructive or weighty confirmations. */
  heavy: () => on && Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {}),
  /** Selection tick — dragging across choices, stepper changes. */
  select: () => on && Haptics.selectionChanged().catch(() => {}),
  /** Success buzz — item saved, bin cataloged. */
  success: () => on && Haptics.notification({ type: NotificationType.Success }).catch(() => {}),
  /** Warning buzz — a flagged/misfiled item. */
  warning: () => on && Haptics.notification({ type: NotificationType.Warning }).catch(() => {}),
  /** Error buzz — a failed action. */
  error: () => on && Haptics.notification({ type: NotificationType.Error }).catch(() => {}),
};
