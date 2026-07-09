import { useEffect, useMemo, useState } from "react";
import { Grid3x3, Printer, Loader2, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { getTemplate, type LabelData } from "@/lib/labelTemplates";
import { LabelTemplateRenderer } from "./LabelTemplateRenderer";
import { printTemplateLabel } from "@/lib/brotherPrint";
import { isPrintingSupported } from "./PrinterService";

interface SpaceLocation {
  id: string;
  name: string;
  type: string;
  grid_rows?: number | null;
  grid_cols?: number | null;
  layout?: { labelTemplateId?: string } | null;
}

interface Slot {
  id: string;
  name: string;
  qr_code: string;
  slot_row: number | null;
  slot_col: number | null;
  slot_index: number | null;
  items: string[];
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  location: SpaceLocation | null;
}

export function SpaceMap({ open, onOpenChange, location }: Props) {
  const { toast } = useToast();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [printingAll, setPrintingAll] = useState(false);

  const templateId = location?.layout?.labelTemplateId;
  const template = useMemo(() => getTemplate(templateId), [templateId]);
  const rows = location?.grid_rows ?? 0;
  const cols = location?.grid_cols ?? 0;

  useEffect(() => {
    if (!open || !location) return;
    let active = true;
    (async () => {
      setLoading(true);
      setSelected(null);
      try {
        const { data: slotRows, error } = await supabase
          .from("locations")
          .select("id, name, qr_code, slot_row, slot_col, slot_index")
          .eq("parent_location_id", location.id)
          .eq("is_slot", true)
          .order("slot_index");
        if (error) throw error;

        const ids = (slotRows ?? []).map((s) => s.id);
        const linksRes = ids.length
          ? await supabase.from("item_locations").select("location_id, item_id").in("location_id", ids).is("date_removed", null)
          : { data: [] as { location_id: string; item_id: string }[] };
        const links = (linksRes as { data: { location_id: string; item_id: string }[] }).data ?? [];
        const itemIds = [...new Set(links.map((l) => l.item_id))];
        const itemsRes = itemIds.length
          ? await supabase.from("items").select("id, name").in("id", itemIds)
          : { data: [] as { id: string; name: string }[] };
        const nameById = new Map<string, string>();
        ((itemsRes as { data: { id: string; name: string }[] }).data ?? []).forEach((it) => nameById.set(it.id, it.name));
        const byLoc = new Map<string, string[]>();
        links.forEach((l) => {
          const nm = nameById.get(l.item_id);
          if (!nm) return;
          const arr = byLoc.get(l.location_id) ?? [];
          arr.push(nm);
          byLoc.set(l.location_id, arr);
        });

        if (active) {
          setSlots((slotRows ?? []).map((s) => ({ ...s, items: byLoc.get(s.id) ?? [] })));
        }
      } catch (e) {
        toast({ title: "Couldn't load map", description: String((e as Error)?.message || e), variant: "destructive" });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [open, location, toast]);

  const slotAt = (r: number, c: number) => slots.find((s) => s.slot_row === r && s.slot_col === c);

  const labelData = (slot: Slot): LabelData => ({
    name: slot.name,
    parent: location?.name ?? "",
    type: location?.type ?? "",
    slot: `R${slot.slot_row}C${slot.slot_col}`,
    row: slot.slot_row ?? "",
    col: slot.slot_col ?? "",
    index: slot.slot_index ?? "",
    qr: slot.qr_code,
  });

  const printOne = async (slot: Slot) => {
    const res = await printTemplateLabel(template, labelData(slot));
    toast({
      title: res.success ? "Printed" : "Print failed",
      description: res.message,
      variant: res.success ? undefined : "destructive",
    });
  };

  const printAll = async () => {
    if (!isPrintingSupported()) {
      toast({ title: "Printing unavailable", description: "Use a Chromium browser with a Brother printer.", variant: "destructive" });
      return;
    }
    setPrintingAll(true);
    let ok = 0;
    for (const s of slots) {
      const res = await printTemplateLabel(template, labelData(s));
      if (res.success) ok++;
      else break; // stop on first failure (e.g. out of tape)
    }
    setPrintingAll(false);
    toast({ title: "Batch print", description: `Printed ${ok} of ${slots.length} labels.` });
  };

  const occupied = slots.filter((s) => s.items.length > 0).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Grid3x3 className="h-5 w-5" /> {location?.name} — {rows}×{cols} map
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {occupied} of {slots.length} slots filled
              </p>
              {isPrintingSupported() && slots.length > 0 && (
                <Button size="sm" variant="outline" onClick={printAll} disabled={printingAll}>
                  {printingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />}
                  Print all labels
                </Button>
              )}
            </div>

            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.max(cols, 1)}, minmax(0, 1fr))` }}>
              {Array.from({ length: rows }).flatMap((_, ri) =>
                Array.from({ length: cols }).map((__, ci) => {
                  const r = ri + 1, c = ci + 1;
                  const slot = slotAt(r, c);
                  const filled = (slot?.items.length ?? 0) > 0;
                  return (
                    <button
                      key={`${r}-${c}`}
                      onClick={() => slot && setSelected(slot)}
                      title={slot ? `${slot.name}${filled ? `: ${slot.items.join(", ")}` : " (empty)"}` : "no slot"}
                      className={[
                        "aspect-square rounded border text-[9px] leading-tight p-1 overflow-hidden transition-colors",
                        !slot ? "bg-muted/30 border-dashed cursor-default" :
                          filled ? "bg-primary/15 border-primary/40 hover:bg-primary/25" :
                            "bg-background hover:bg-muted",
                        selected?.id === slot?.id ? "ring-2 ring-primary" : "",
                      ].join(" ")}
                    >
                      <div className="font-mono text-muted-foreground">R{r}C{c}</div>
                      {filled && <Package className="h-3 w-3 mx-auto mt-1 text-primary" />}
                    </button>
                  );
                }),
              )}
            </div>

            {selected && (
              <div className="rounded-md border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{selected.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{selected.qr_code}</div>
                  </div>
                  {isPrintingSupported() && (
                    <Button size="sm" variant="outline" onClick={() => printOne(selected)}>
                      <Printer className="h-4 w-4 mr-2" /> Print label
                    </Button>
                  )}
                </div>
                <div className="text-sm">
                  {selected.items.length > 0 ? (
                    <ul className="list-disc list-inside text-muted-foreground">
                      {selected.items.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground">Empty slot.</p>
                  )}
                </div>
                <div className="flex justify-center pt-1">
                  <LabelTemplateRenderer template={template} data={labelData(selected)} pxPerMm={4} />
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
