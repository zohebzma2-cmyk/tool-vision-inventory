// Duplicate detection: is this item already filed in this bin? Used by the hands-free flow so
// presenting the same tool twice bumps its quantity instead of creating a second row (and wasting a
// label). Match is case/space-insensitive on the item name among the bin's active contents.

import { supabase } from "@/integrations/supabase/client";

export interface BinItemMatch { itemId: string; linkId: string; name: string; code: string | null; itemQty: number; linkQty: number }

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\w]+/g, " ").trim();
}

/** Find an item already in `binId` whose name matches `name`, or null. */
export async function findItemInBin(binId: string, name: string): Promise<BinItemMatch | null> {
  const target = norm(name);
  if (!target) return null;
  // Active links in this bin, with their item's name + quantity.
  const { data } = await supabase
    .from("item_locations")
    .select("id, quantity, item_id, items!inner(id, name, quantity, qr_code)")
    .eq("location_id", binId)
    .is("date_removed", null);
  type ItemRow = { id: string; name: string; quantity: number | null; qr_code: string | null };
  for (const row of (data ?? []) as Array<{ id: string; quantity: number | null; items: ItemRow | ItemRow[] }>) {
    const it = Array.isArray(row.items) ? row.items[0] : row.items;
    if (it && norm(it.name) === target) {
      return { itemId: it.id, linkId: row.id, name: it.name, code: it.qr_code, itemQty: it.quantity || 1, linkQty: row.quantity || 1 };
    }
  }
  return null;
}

/** Add `add` to both the item's total quantity and its quantity in this bin. Returns the new bin total. */
export async function mergeQuantity(match: BinItemMatch, add: number): Promise<number> {
  const newLinkQty = match.linkQty + add;
  await supabase.from("items").update({ quantity: match.itemQty + add }).eq("id", match.itemId);
  await supabase.from("item_locations").update({ quantity: newLinkQty }).eq("id", match.linkId);
  return newLinkQty;
}
