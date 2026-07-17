import { supabase } from "@/integrations/supabase/client";
import { generateQRCode } from "./slots";
import { persistInventoryImage } from "./imageStorage";

/** A freeform storage spot: one physical item's place on a board/wall, as a
 * normalized rect on the space photo (not a grid cell). */
export interface SpotDef {
  label: string;
  box: { x: number; y: number; w: number; h: number };
}

export interface CreateSpaceWithSpotsInput {
  name: string;
  type: string;
  imagePath?: string | null;
  parentLocationId?: string | null;
  labelTemplateId: string;
  spots: SpotDef[];
  /** Real width of the physical board in millimetres — turns rects into mm coordinates. */
  realWidthMm?: number | null;
  /** Real height in mm; derived from the photo aspect when omitted. */
  realHeightMm?: number | null;
}

/** Centre point of a spot in real millimetres from the board's top-left corner. */
export function spotMm(
  box: { x: number; y: number; w: number; h: number },
  realWidthMm: number,
  realHeightMm: number,
): { xMm: number; yMm: number; wMm: number; hMm: number } {
  return {
    xMm: Math.round((box.x + box.w / 2) * realWidthMm),
    yMm: Math.round((box.y + box.h / 2) * realHeightMm),
    wMm: Math.round(box.w * realWidthMm),
    hMm: Math.round(box.h * realHeightMm),
  };
}

/** Create a space whose children are freeform spots (each with its own rect), not a grid. */
export async function createSpaceWithSpots(input: CreateSpaceWithSpotsInput) {
  const layout = {
    mode: "spots",
    labelTemplateId: input.labelTemplateId,
    realWidthMm: input.realWidthMm ?? null,
    realHeightMm: input.realHeightMm ?? null,
  };

  const { data: parent, error: pErr } = await supabase
    .from("locations")
    .insert([{
      name: input.name,
      type: input.type,
      qr_code: generateQRCode(),
      is_slot: false,
      // grid_rows/cols describe the *spot count* so existing "is this a mapped space"
      // checks (grid_rows != null) keep working for spot spaces too.
      grid_rows: 1,
      grid_cols: Math.max(1, input.spots.length),
      image_path: await persistInventoryImage(input.imagePath, "bin"),
      parent_location_id: input.parentLocationId || null,
      layout,
    }])
    .select()
    .single();
  if (pErr) throw pErr;

  const rows = input.spots.map((s, i) => ({
    name: s.label?.trim() || `Spot ${i + 1}`,
    type: "slot",
    qr_code: generateQRCode(),
    parent_location_id: parent.id,
    is_slot: true,
    slot_row: 1,
    slot_col: i + 1,
    slot_index: i + 1,
    capacity: 1,
    layout: { box: s.box },
  }));

  const created: unknown[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await supabase.from("locations").insert(rows.slice(i, i + 200)).select();
    if (error) throw error;
    created.push(...(data || []));
  }
  return { parent, spots: created };
}
