// SKU / barcode (UPC/EAN) product lookup. When an object has a printed barcode, the app looks the
// number up, shows the matched product, and (on the user's confirmation) auto-fills the new item's
// name / brand / category. The lookup goes through the vision Worker's /sku-lookup (keeps any API
// key server-side and avoids browser CORS), which proxies a UPC database.

import { supabase } from "@/integrations/supabase/client";
import { visionApiUrl } from "@/lib/vision";

export interface SkuProduct {
  title: string;
  brand: string;
  model: string;
  category: string;
  /** The looked-up barcode, echoed back. */
  upc: string;
}

/** A UPC-A (12) / EAN-13 / EAN-8 barcode is all digits. Reject anything else early. */
export function looksLikeSku(code: string): boolean {
  return /^\d{8}$|^\d{12,13}$/.test(code.trim());
}

/**
 * Look up a barcode. Returns the best-match product, or null if there's no match / lookup isn't
 * available. Never throws — callers fall back to manual entry.
 */
export async function lookupSku(upc: string): Promise<SkuProduct | null> {
  const base = visionApiUrl();
  const code = upc.trim();
  if (!base || !looksLikeSku(code)) return null;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) headers["Authorization"] = `Bearer ${data.session.access_token}`;
    const res = await fetch(`${base}/sku-lookup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ upc: code }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || !j.title) return null;
    return {
      title: String(j.title),
      brand: String(j.brand || ""),
      model: String(j.model || ""),
      category: String(j.category || ""),
      upc: code,
    };
  } catch {
    return null;
  }
}
