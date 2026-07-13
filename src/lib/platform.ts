import { Capacitor } from "@capacitor/core";

/** True inside the native iOS/Android app (Capacitor), false in a desktop/web browser. */
export const isNative = Capacitor.isNativePlatform();

/** The native app leans "scanner / remote": scanning a label is the primary field action.
 * The desktop web app leans "setup": mapping spaces and adding tools. Both can do everything;
 * this only decides what each surface leads with. */
export const leadsWithScanner = isNative;
