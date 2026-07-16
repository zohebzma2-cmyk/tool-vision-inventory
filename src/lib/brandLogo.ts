// Brand logos via logos.dev. A brand name (e.g. "DeWalt") is resolved to its domain through the
// vision Worker's /brand-logo endpoint (which holds the SECRET key server-side), and the public
// image is then fetched from img.logo.dev with the publishable key. Results are cached in memory +
// localStorage so each brand is looked up at most once per device.

import { supabase } from "@/integrations/supabase/client";
import { visionApiUrl } from "@/lib/vision";

const PK = import.meta.env.VITE_LOGODEV_PK as string | undefined;
const LS_KEY = "tv-brand-domains";
const mem = new Map<string, string | null>();

function loadCache(): Record<string, string | null> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
}
function saveCache(map: Record<string, string | null>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

/** Public logo image URL for a domain (null when no publishable key is configured). */
export function logoImageUrl(domain: string, size = 64): string | null {
  if (!PK || !domain) return null;
  return `https://img.logo.dev/${encodeURIComponent(domain)}?token=${PK}&size=${size}&format=png&retina=true`;
}

/** Resolve a brand name → its domain (cached). Returns null on no match / unavailable — never throws. */
export async function resolveBrandDomain(brand: string): Promise<string | null> {
  const key = brand.trim().toLowerCase();
  if (!key || !PK) return null;
  if (mem.has(key)) return mem.get(key)!;
  const disk = loadCache();
  if (key in disk) { mem.set(key, disk[key]); return disk[key]; }

  const base = visionApiUrl();
  if (!base) return null;
  try {
    const { data } = await supabase.auth.getSession();
    const headers: Record<string, string> = {};
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
    const res = await fetch(`${base}/brand-logo?q=${encodeURIComponent(brand)}`, { headers, signal: AbortSignal.timeout(9000) });
    const domain: string | null = res.ok ? ((await res.json()).domain ?? null) : null;
    mem.set(key, domain);
    disk[key] = domain;
    saveCache(disk);
    return domain;
  } catch {
    return null;
  }
}
