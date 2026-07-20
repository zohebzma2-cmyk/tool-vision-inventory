// Auto-print bridge: turn the desktop station into a printer for whatever the iPad scans. When
// enabled, this listens (Supabase realtime) for newly-created items and prints each one's label on
// the local QL-800 — so as you scan on the iPad, labels roll out at the station.
//
// Reliability (this is the thing you trust a real cataloging session to):
//  - Realtime INSERT is the fast path, but a socket can drop (Mac sleep, Wi-Fi blip, backgrounded/
//    App-Nap'd tab) and realtime replays NOTHING on reconnect. So on every (re)subscribe, and when the
//    tab wakes / the network returns, we run a CATCH-UP query for any items created past a persisted
//    watermark and print those too. No scan silently goes unlabeled.
//  - The connection status is surfaced (a toast) if the channel errors, so it's never silently dead.
//  - Skips items THIS session created (RapidMode prints its own) and SKU'd (UPC) parts.
//
// The caller must only enable this where the connector is reachable (see canReachConnector) — never on
// the live-loaded iPad, where prints can't reach the local connector.

import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getLabelMedia } from "@/components/inventory/PrinterService";
import { renderItemLabel, loadBrandLogo } from "@/lib/itemLabel";
import { printResilient } from "@/lib/printQueue";
import { isSessionItem } from "@/lib/sessionPrints";
import { toast } from "@/hooks/use-toast";

const WATERMARK_KEY = "tv_autoprint_watermark"; // created_at of the newest item we've handled

interface IncomingItem {
  id: string;
  name?: string;
  qr_code?: string;
  brand?: string;
  category?: string;
  notes?: string;
  created_at?: string;
}

export function useAutoPrintBridge(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const printed = new Set<string>();
    let alive = true;

    const getWatermark = () => { try { return localStorage.getItem(WATERMARK_KEY) || ""; } catch { return ""; } };
    const bumpWatermark = (ts?: string) => {
      if (!ts) return;
      try { if (ts > getWatermark()) localStorage.setItem(WATERMARK_KEY, ts); } catch { /* ignore */ }
    };

    const printItem = async (item: IncomingItem) => {
      if (!alive || !item?.id || !item.qr_code) return;
      if (printed.has(item.id)) return;
      // Deliberate skips are terminal DECISIONS, not failures, so they must still advance the
      // watermark. Rapid Mode labels its own items as it goes and marks them session items; if that
      // skip left the watermark behind, a whole session would sit above it, and the next catch-up
      // after a reload (sessionItemIds is in-memory and dies with the page) would reprint every one.
      // Same for SKU'd parts, which are deliberately never TV-labeled.
      if (isSessionItem(item.id) || (item.notes || "").includes("UPC ")) {
        bumpWatermark(item.created_at);
        return;
      }
      printed.add(item.id);
      try {
        const media = getLabelMedia();
        const logo = await loadBrandLogo(item.brand);
        const sub = [item.category, item.brand].filter(Boolean) as string[];
        const label = renderItemLabel({ name: item.name || "Item", code: item.qr_code, sub, media, logo }).toDataURL("image/png");
        const res = await printResilient(label, media, item.name || "Item");
        // Advance the watermark once it's printed OR safely queued (printResilient retries queued jobs),
        // so catch-up doesn't re-print it. On a hard failure we DON'T advance — catch-up retries later.
        if (res.success || res.queued) bumpWatermark(item.created_at);
      } catch {
        printed.delete(item.id); // render failure — let a later catch-up retry it
      }
    };

    // Print anything created while we weren't listening. Runs on first subscribe, every reconnect,
    // tab wake, and network-return — the safety net that makes missed realtime events harmless.
    let catchingUp = false;
    const catchUp = async () => {
      if (!alive || catchingUp) return;
      catchingUp = true;
      try {
        const wm = getWatermark();
        let q = supabase
          .from("items")
          .select("id,name,qr_code,brand,category,notes,created_at")
          .order("created_at", { ascending: true })
          .limit(300);
        // First ever run has no watermark: only look back 10 min so turning auto-print ON doesn't
        // reprint your entire history. After that the watermark tracks exactly what's been handled.
        q = wm ? q.gt("created_at", wm) : q.gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());
        const { data } = await q;
        for (const it of (data || []) as IncomingItem[]) {
          if (!alive) break;
          await printItem(it);
        }
      } finally {
        catchingUp = false;
      }
    };

    const channel = supabase
      .channel("tv-autoprint-bridge")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "items" }, (payload) => {
        void printItem(payload.new as IncomingItem);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void catchUp(); // fill any gap from before/at (re)connect
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          toast({ title: "Auto-print reconnecting…", description: "Labels will catch up automatically once it's back." });
        }
      });

    const onWake = () => { if (!document.hidden) void catchUp(); };
    const onOnline = () => void catchUp();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onOnline);

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onOnline);
      supabase.removeChannel(channel);
    };
  }, [enabled]);
}
