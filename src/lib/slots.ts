import { supabase } from "@/integrations/supabase/client";
import { renderTokens, type LabelData } from "./labelTemplates";

/** Unique, human-scannable QR/location code. Matches the app's existing LOC- convention. */
export function generateQRCode(prefix = "LOC"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
}

export interface SlotDef {
  slot_row: number;
  slot_col: number;
  slot_index: number;
  name: string;
  qr_code: string;
}

/**
 * Build slot definitions for a rows x cols grid using a naming scheme.
 * Scheme tokens: {{parent}} {{row}} {{col}} {{index}} {{slot}} (slot = "R2C3").
 */
export function buildSlotDefs(opts: {
  rows: number;
  cols: number;
  namingScheme: string;
  parentName: string;
  pad?: boolean;
}): SlotDef[] {
  const { rows, cols, namingScheme, parentName } = opts;
  const pad = opts.pad ?? true;
  const total = rows * cols;
  const idxWidth = String(total).length;
  const defs: SlotDef[] = [];
  let index = 0;
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      index++;
      const data: LabelData = {
        parent: parentName,
        row: pad ? String(r).padStart(2, "0") : String(r),
        col: pad ? String(c).padStart(2, "0") : String(c),
        index: pad ? String(index).padStart(idxWidth, "0") : String(index),
        slot: `R${r}C${c}`,
      };
      const name = renderTokens(namingScheme, data).trim() || `${parentName} R${r}C${c}`;
      defs.push({ slot_row: r, slot_col: c, slot_index: index, name, qr_code: generateQRCode() });
    }
  }
  return defs;
}

export interface CreateSpaceInput {
  name: string;
  type: string;
  description?: string;
  gridRows: number;
  gridCols: number;
  imagePath?: string | null;
  namingScheme: string;
  labelTemplateId: string;
  pad?: boolean;
  slotType?: string;
  /** Parent place (garage, shed, …) this space lives in. */
  parentLocationId?: string | null;
}

/** Find a top-level place by name, creating it if needed (e.g. "Garage", "Shed"). */
export async function findOrCreatePlace(name: string, type = "space") {
  const trimmed = name.trim();
  const { data: existing } = await supabase
    .from("locations")
    .select("id, name")
    .eq("is_slot", false)
    .is("parent_location_id", null)
    .is("grid_rows", null)
    .ilike("name", trimmed)
    .maybeSingle();
  if (existing) return existing;

  const { data, error } = await supabase
    .from("locations")
    .insert([{ name: trimmed, type, qr_code: generateQRCode(), is_slot: false }])
    .select("id, name")
    .single();
  if (error) throw error;
  return data;
}

/** Create the container location plus all of its slot child-locations in Supabase. */
export async function createSpaceWithSlots(input: CreateSpaceInput) {
  const layout = {
    namingScheme: input.namingScheme,
    labelTemplateId: input.labelTemplateId,
    pad: input.pad ?? true,
  };

  const { data: parent, error: pErr } = await supabase
    .from("locations")
    .insert([
      {
        name: input.name,
        type: input.type,
        qr_code: generateQRCode(),
        description: input.description || null,
        grid_rows: input.gridRows,
        grid_cols: input.gridCols,
        is_slot: false,
        image_path: input.imagePath || null,
        parent_location_id: input.parentLocationId || null,
        layout,
      },
    ])
    .select()
    .single();
  if (pErr) throw pErr;

  const defs = buildSlotDefs({
    rows: input.gridRows,
    cols: input.gridCols,
    namingScheme: input.namingScheme,
    parentName: input.name,
    pad: input.pad,
  });

  const slotType = input.slotType || "slot";
  const rows = defs.map((d) => ({
    name: d.name,
    type: slotType,
    qr_code: d.qr_code,
    parent_location_id: parent.id,
    is_slot: true,
    slot_row: d.slot_row,
    slot_col: d.slot_col,
    slot_index: d.slot_index,
    capacity: 1,
  }));

  const chunkSize = 200;
  const created: unknown[] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { data, error } = await supabase
      .from("locations")
      .insert(rows.slice(i, i + chunkSize))
      .select();
    if (error) throw error;
    created.push(...(data || []));
  }

  return { parent, slots: created };
}
