// Auto-print bridge: turn the desktop station into a printer for whatever the iPad scans. When
// enabled, this listens (Supabase realtime) for newly-created items and prints each one's label on
// the local QL-800 — so as you scan on the iPad, labels roll out at the station to apply on the go.
//
// Only meaningful where label output works (the desktop with the connector). It skips items THIS
// session created (so the desktop's own Rapid Mode prints don't double up) and only prints items that
// arrive after it starts (no backfill storm on connect).

import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isLabelOutputSupported } from "@/lib/brotherPrint";
import { getLabelMedia } from "@/components/inventory/PrinterService";
import { renderItemLabel, loadBrandLogo } from "@/lib/itemLabel";
import { printResilient } from "@/lib/printQueue";
import { isSessionItem } from "@/lib/sessionPrints";

interface IncomingItem {
  id: string;
  name?: string;
  qr_code?: string;
  brand?: string;
  category?: string;
  notes?: string;
}

export function useAutoPrintBridge(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isLabelOutputSupported()) return;
    const printed = new Set<string>();

    const channel = supabase
      .channel("tv-autoprint-bridge")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "items" }, async (payload) => {
        const item = payload.new as IncomingItem;
        if (!item?.id || !item.qr_code || printed.has(item.id) || isSessionItem(item.id)) return;
        // SKU'd parts store a UPC in notes and are deliberately not TV-labeled (owner's rule).
        if ((item.notes || "").includes("UPC ")) return;
        printed.add(item.id);
        try {
          const media = getLabelMedia();
          const logo = await loadBrandLogo(item.brand);
          const sub = [item.category, item.brand].filter(Boolean) as string[];
          const label = renderItemLabel({ name: item.name || "Item", code: item.qr_code, sub, media, logo }).toDataURL("image/png");
          await printResilient(label, media, item.name || "Item");
        } catch {
          printed.delete(item.id); // let a later change retry if the print pipeline hiccupped
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [enabled]);
}
