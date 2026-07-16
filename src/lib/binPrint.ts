// Batch-print every bin label under a shelf/space — the in-app version of the bin-wall labeling flow.
// Renders a barcode label per bin at the loaded tape size and prints them through the desktop
// connector, with a couple of retries so a transient printer hiccup doesn't drop a label.

import { supabase } from "@/integrations/supabase/client";
import { renderBinLabel } from "@/lib/binLabel";
import { getLabelMedia } from "@/components/inventory/PrinterService";
import { printResilient } from "@/lib/printQueue";

export interface BinPrintResult { printed: number; total: number; failed: number[]; queued: number[] }

/** Print a label for every slot/bin directly under `shelfId`. `onProgress(done,total,label)` fires per bin. */
export async function printBinLabels(
  shelfId: string,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<BinPrintResult> {
  const media = getLabelMedia();
  const { data: shelf } = await supabase
    .from("locations").select("id,name").eq("id", shelfId).maybeSingle();
  const locationText = shelf?.name || "Bin";
  const { data: bins } = await supabase
    .from("locations").select("id,name,qr_code,slot_index,category")
    .eq("parent_location_id", shelfId).eq("is_slot", true)
    .order("slot_index");
  const list = bins ?? [];
  let printed = 0;
  const failed: number[] = [];
  const queued: number[] = [];

  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const num = (b.slot_index ?? i) + 1;
    const code = b.qr_code || `BIN${num}`;
    const dataUrl = renderBinLabel({
      number: num, code, location: locationText, category: (b as { category?: string }).category || undefined, media,
    }).toDataURL("image/png");
    // Print now; anything that can't land (printer asleep, connector down) is queued and retried
    // in the background so a batch is never silently short a label.
    const res = await printResilient(dataUrl, media, `Bin ${num}`);
    if (res.success) printed++;
    else { failed.push(num); if (res.queued) queued.push(num); }
    onProgress?.(i + 1, list.length, `Bin ${num}`);
  }
  return { printed, total: list.length, failed, queued };
}
