import { useEffect, useState } from "react";

// A tiny reactive boolean backed by localStorage, synced across components in the same tab (custom
// event) and across tabs (storage event). Used for station-level toggles like the auto-print bridge.

const EVT = "tv-localflag";

export function setLocalFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVT, { detail: key }));
}

export function useLocalFlag(key: string): [boolean, (v: boolean) => void] {
  const [val, setVal] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  useEffect(() => {
    const sync = () => setVal(localStorage.getItem(key) === "1");
    window.addEventListener(EVT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [key]);
  return [val, (v: boolean) => setLocalFlag(key, v)];
}
