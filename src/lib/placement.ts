import { supabase } from "@/integrations/supabase/client";

/**
 * Moving an item between locations, done once and correctly.
 *
 * `item_locations` has UNIQUE(item_id, location_id) and removal is a SOFT delete (date_removed).
 * Together those mean a plain INSERT throws 23505 whenever the item has *ever* lived in the target
 * before — so the row must be REACTIVATED instead. Getting this wrong is not a cosmetic failure:
 * the source rows are removed first, so a throw on the insert leaves the item with zero active
 * placements. It vanishes from its bin and reappears as "homeless".
 *
 * This bites hardest exactly where it looks safest — re-filing something into the bin it came out
 * of, or giving a homeless item back the home whose row was soft-deleted to make it homeless.
 */

/** Sum the item's active placements, so a move never silently resets quantity to 1. */
async function activeRows(itemId: string) {
  const { data, error } = await supabase
    .from("item_locations")
    .select("id,location_id,quantity")
    .eq("item_id", itemId)
    .is("date_removed", null);
  if (error) throw error;
  return (data || []) as Array<{ id: string; location_id: string; quantity?: number }>;
}

/**
 * Put `itemId` into `locationId`, clearing it out of every other location.
 *
 * @param quantity total to land in the target; defaults to the summed quantity it had before.
 * @returns the quantity actually placed.
 */
export async function moveItemTo(itemId: string, locationId: string, quantity?: number): Promise<number> {
  const rows = await activeRows(itemId);
  const qty = quantity ?? (rows.reduce((s, r) => s + (r.quantity || 1), 0) || 1);

  // Clear every OTHER location first. Excluding the target matters: removing and then re-adding the
  // same row is what turns a no-op move into data loss.
  const toRemove = rows.filter((r) => r.location_id !== locationId).map((r) => r.id);
  if (toRemove.length) {
    const { error } = await supabase
      .from("item_locations")
      .update({ date_removed: new Date().toISOString() })
      .in("id", toRemove);
    if (error) throw error;
  }

  await landIn(itemId, locationId, qty);
  return qty;
}

/**
 * Give `itemId` a home at `locationId` without disturbing any other placement.
 * Used for homeless items, where there is nothing to clear out.
 */
export async function assignItemTo(itemId: string, locationId: string, quantity: number): Promise<number> {
  await landIn(itemId, locationId, quantity);
  return quantity;
}

/** Reactivate the prior row for this (item, location) if one exists, else insert a fresh one. */
async function landIn(itemId: string, locationId: string, qty: number) {
  const { data: prior, error: priorErr } = await supabase
    .from("item_locations")
    .select("id")
    .eq("item_id", itemId)
    .eq("location_id", locationId)
    .limit(1);
  if (priorErr) throw priorErr;

  if (prior && prior[0]) {
    const { error } = await supabase
      .from("item_locations")
      .update({ date_removed: null, quantity: qty })
      .eq("id", (prior[0] as { id: string }).id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from("item_locations")
    .insert({ item_id: itemId, location_id: locationId, quantity: qty });
  if (error) throw error;
}
