// Organization analysis ("Sort Mode"): looks at every location + item + active placement and surfaces
// concrete, actionable suggestions — spaces filling up, items in the wrong bin, and items with no home.
//
// Pure heuristics over data already in Supabase (no AI, no new tables). The same shape backs both the
// live in-app Sort Mode screen and the weekly digest, so a suggestion looks identical in either place.

import { supabase } from "@/integrations/supabase/client";

export type SuggestionKind = "overfull" | "misplaced" | "homeless";

export interface OrgSuggestion {
  kind: SuggestionKind;
  severity: "info" | "warning" | "urgent";
  title: string;
  detail: string;
  itemId?: string;
  locationId?: string;
  /** For "misplaced": a location the item would fit better (matching category). */
  suggestedLocationId?: string;
  suggestedLocationName?: string;
}

export interface Fullness {
  locationId: string;
  name: string;
  used: number;
  cap: number;
  ratio: number; // 0..1+
}

export interface OrgReport {
  suggestions: OrgSuggestion[];
  fullness: Fullness[];
  summary: string;
  counts: { overfull: number; misplaced: number; homeless: number };
}

type Loc = {
  id: string; name: string; type: string; category: string | null;
  capacity: number | null; grid_rows: number | null; grid_cols: number | null;
  is_slot: boolean; parent_location_id: string | null;
};
type Item = { id: string; name: string; category: string; brand: string | null };
type Placement = { item_id: string; location_id: string; quantity: number };

const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase();

/** Capacity of a location: explicit capacity wins; else a slot grid; else its slot children count. */
function capacityOf(loc: Loc, slotChildren: number): number | null {
  if (loc.capacity && loc.capacity > 0) return loc.capacity;
  if (loc.grid_rows && loc.grid_cols) return loc.grid_rows * loc.grid_cols;
  if (slotChildren > 0) return slotChildren;
  return null; // unknown capacity → can't compute fullness
}

/** Dominant category among a set of items, only if there's a clear majority (>50%) over ≥3 items. */
function dominantCategory(cats: string[]): string | null {
  if (cats.length < 3) return null;
  const tally = new Map<string, number>();
  for (const c of cats) tally.set(c, (tally.get(c) || 0) + 1);
  let best = "", n = 0;
  for (const [c, k] of tally) if (k > n) { best = c; n = k; }
  return n / cats.length > 0.5 && best ? best : null;
}

export async function computeOrgReport(): Promise<OrgReport> {
  const [locRes, itemRes, placeRes] = await Promise.all([
    supabase.from("locations").select("id,name,type,category,capacity,grid_rows,grid_cols,is_slot,parent_location_id"),
    supabase.from("items").select("id,name,category,brand"),
    supabase.from("item_locations").select("item_id,location_id,quantity").is("date_removed", null),
  ]);
  const locations = (locRes.data ?? []) as Loc[];
  const items = (itemRes.data ?? []) as Item[];
  const placements = (placeRes.data ?? []) as Placement[];

  const locById = new Map(locations.map((l) => [l.id, l]));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const slotChildCount = new Map<string, number>();
  for (const l of locations) if (l.parent_location_id && l.is_slot)
    slotChildCount.set(l.parent_location_id, (slotChildCount.get(l.parent_location_id) || 0) + 1);

  // Group active placements by location, and track which items are placed anywhere.
  const itemsInLoc = new Map<string, Placement[]>();
  const placedItemIds = new Set<string>();
  for (const p of placements) {
    if (!itemsInLoc.has(p.location_id)) itemsInLoc.set(p.location_id, []);
    itemsInLoc.get(p.location_id)!.push(p);
    placedItemIds.add(p.item_id);
  }

  // Storage locations we assess: real containers (not individual slots), that hold items or have capacity.
  const storage = locations.filter((l) => !l.is_slot);

  const suggestions: OrgSuggestion[] = [];
  const fullness: Fullness[] = [];

  // --- 1) Overfull spaces --------------------------------------------------
  for (const loc of storage) {
    // Count items placed directly in this location AND (for slotted units) in its occupied slot children.
    const direct = itemsInLoc.get(loc.id) ?? [];
    const childSlots = locations.filter((c) => c.parent_location_id === loc.id && c.is_slot);
    const occupiedSlots = childSlots.filter((c) => (itemsInLoc.get(c.id) ?? []).length > 0).length;
    const used = childSlots.length > 0 ? occupiedSlots : direct.length;
    const cap = capacityOf(loc, childSlots.length);
    if (cap == null || used === 0) continue;
    const ratio = used / cap;
    fullness.push({ locationId: loc.id, name: loc.name, used, cap, ratio });
    if (ratio >= 1) {
      suggestions.push({
        kind: "overfull", severity: "urgent", locationId: loc.id,
        title: `${loc.name} is full`,
        detail: `${used} of ${cap} spots used. Move rarely-used items out, or add another ${loc.type || "bin"}.`,
      });
    } else if (ratio >= 0.8) {
      suggestions.push({
        kind: "overfull", severity: "warning", locationId: loc.id,
        title: `${loc.name} is getting full`,
        detail: `${used} of ${cap} spots used (${Math.round(ratio * 100)}%). Good time to tidy before it overflows.`,
      });
    }
  }

  // --- 2) Misplaced items --------------------------------------------------
  // Precompute, per category, a location whose own category matches — the natural "home" to suggest.
  const homeForCategory = new Map<string, Loc>();
  for (const loc of storage) if (loc.category) {
    const key = norm(loc.category);
    if (!homeForCategory.has(key)) homeForCategory.set(key, loc);
  }

  for (const loc of storage) {
    const placed = (itemsInLoc.get(loc.id) ?? [])
      .map((p) => itemById.get(p.item_id))
      .filter((i): i is Item => !!i);
    if (placed.length === 0) continue;

    // The bin's "theme": its own category if set, else the dominant category of what's inside.
    const theme = loc.category ? norm(loc.category) : dominantCategory(placed.map((i) => norm(i.category)));
    if (!theme) continue;

    for (const it of placed) {
      if (norm(it.category) && norm(it.category) !== theme) {
        const home = homeForCategory.get(norm(it.category));
        // Don't suggest moving it back into the same bin.
        const suggested = home && home.id !== loc.id ? home : undefined;
        suggestions.push({
          kind: "misplaced", severity: "info", itemId: it.id, locationId: loc.id,
          suggestedLocationId: suggested?.id, suggestedLocationName: suggested?.name,
          title: `${it.name} looks out of place`,
          detail: suggested
            ? `It's a ${it.category} item in ${loc.name} (${loc.category || theme}). Move it to ${suggested.name}?`
            : `It's a ${it.category} item sitting in ${loc.name} (${loc.category || theme}).`,
        });
      }
    }
  }

  // --- 3) Homeless items (no active placement) -----------------------------
  for (const it of items) {
    if (!placedItemIds.has(it.id)) {
      suggestions.push({
        kind: "homeless", severity: "info", itemId: it.id,
        title: `${it.name} has no home`,
        detail: `Not assigned to any bin or space yet. Give it a spot so you can find it later.`,
      });
    }
  }

  // Sort: urgent → warning → info; overfull first within a tier.
  const sevRank = { urgent: 0, warning: 1, info: 2 } as const;
  const kindRank = { overfull: 0, misplaced: 1, homeless: 2 } as const;
  suggestions.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || kindRank[a.kind] - kindRank[b.kind]);
  fullness.sort((a, b) => b.ratio - a.ratio);

  const counts = {
    overfull: suggestions.filter((s) => s.kind === "overfull").length,
    misplaced: suggestions.filter((s) => s.kind === "misplaced").length,
    homeless: suggestions.filter((s) => s.kind === "homeless").length,
  };

  const parts: string[] = [];
  if (counts.overfull) parts.push(`${counts.overfull} space${counts.overfull > 1 ? "s" : ""} filling up`);
  if (counts.misplaced) parts.push(`${counts.misplaced} item${counts.misplaced > 1 ? "s" : ""} out of place`);
  if (counts.homeless) parts.push(`${counts.homeless} item${counts.homeless > 1 ? "s" : ""} with no home`);
  const summary = parts.length ? `Found ${parts.join(", ")}.` : "Everything looks well organized — nothing to sort right now.";

  return { suggestions, fullness, summary, counts };
}
