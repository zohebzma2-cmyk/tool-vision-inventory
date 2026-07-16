// Batch-print every bin label under a shelf/space — the in-app version of the bin-wall labeling flow.
// Renders a barcode label per bin at the loaded tape size and prints them through the desktop
// connector, with a couple of retries so a transient printer hiccup doesn't drop a label.

import { supabase } from "@/integrations/supabase/client";
import { renderBinLabel } from "@/lib/binLabel";
import { printImageViaConnector, getLabelMedia } from "@/components/inventory/PrinterService";

export interface BinPrintResult { printed: number; total: number; failed: number[] }

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
    .from("locations").select("id,name,qr_code,slot_index")
    .eq("parent_location_id", shelfId).eq("is_slot", true)
    .order("slot_index");
  const list = bins ?? [];
  let printed = 0;
  const failed: number[] = [];

  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const num = (b.slot_index ?? i) + 1;
    const code = b.qr_code || `BIN${num}`;
    const dataUrl = renderBinLabel({ number: num, code, location: locationText, media }).toDataURL("image/png");
    let ok = false;
    for (let t = 0; t < 3 && !ok; t++) {
      const res = await printImageViaConnector(dataUrl, media);
      ok = !!res?.success;
    }
    if (ok) printed++; else failed.push(num);
    onProgress?.(i + 1, list.length, `Bin ${num}`);
  }
  return { printed, total: list.length, failed };
}
