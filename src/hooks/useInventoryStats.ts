import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface InventoryStats {
  itemCount: number;
  locationCount: number;
  categoryCounts: Record<string, number>;
  totalValue: number;
  loading: boolean;
}

/** Live counts for the header strip and the Overview tab — real data, no placeholders. */
export function useInventoryStats() {
  const [stats, setStats] = useState<InventoryStats>({
    itemCount: 0,
    locationCount: 0,
    categoryCounts: {},
    totalValue: 0,
    loading: true,
  });

  const refresh = useCallback(async () => {
    try {
      const [items, locations] = await Promise.all([
        supabase.from("items").select("category, quantity, purchase_price"),
        supabase
          .from("locations")
          .select("id", { count: "exact", head: true })
          .eq("is_slot", false),
      ]);

      const rows = items.data || [];
      const categoryCounts: Record<string, number> = {};
      let totalValue = 0;
      for (const r of rows as Array<{ category: string; quantity: number; purchase_price: number | null }>) {
        categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;
        if (r.purchase_price) totalValue += Number(r.purchase_price) * (r.quantity || 1);
      }

      setStats({
        itemCount: rows.length,
        locationCount: locations.count || 0,
        categoryCounts,
        totalValue,
        loading: false,
      });
    } catch {
      setStats((s) => ({ ...s, loading: false }));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...stats, refresh };
}
