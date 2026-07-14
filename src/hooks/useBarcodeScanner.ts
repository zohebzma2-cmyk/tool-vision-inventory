import { useEffect, useRef } from "react";

/**
 * Detect a USB barcode / QR scanner (a "keyboard-wedge" device): it types the decoded value as a
 * fast burst of keystrokes terminated by Enter. We buffer printable keys that arrive faster than a
 * human could type and, on Enter, hand the assembled code to `onScan`. Real typing (slow, or into a
 * focused input/textarea) is ignored, so this never fights the user's keyboard.
 */
export function useBarcodeScanner(
  onScan: (code: string) => void,
  opts?: { minLength?: number; maxGapMs?: number },
) {
  const buf = useRef("");
  const lastT = useRef(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const minLength = opts?.minLength ?? 4;
  const maxGap = opts?.maxGapMs ?? 50; // scanners emit chars ~1-10ms apart; humans far slower

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        return; // let real typing land where it's focused
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastT.current > maxGap) buf.current = ""; // slow gap → not part of a scan burst
      lastT.current = now;

      if (e.key === "Enter") {
        const code = buf.current.trim();
        buf.current = "";
        if (code.length >= minLength) {
          e.preventDefault();
          onScanRef.current(code);
        }
        return;
      }
      if (e.key.length === 1) buf.current += e.key; // a single printable character
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [minLength, maxGap]);
}
