import { useEffect, useMemo, useState } from "react";
import { Grid3x3, Printer, Loader2, Package, Camera, MapPin, Boxes, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/adaptive-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { type LabelData } from "@/lib/labelTemplates";
import { resolveTemplate } from "@/lib/customTemplates";
import { LabelTemplateRenderer } from "./LabelTemplateRenderer";
import { printTemplateLabel, outputLabel, isLabelOutputSupported } from "@/lib/brotherPrint";
import { isPrintingSupported } from "./PrinterService";
import { BinFillDialog } from "./BinFillDialog";
import { SortBinDialog } from "./SortBinDialog";
import { RapidMode } from "./RapidMode";
import { cellQuad, quadToSvgPoints, type QuadCorners } from "@/lib/quad";

interface SpaceLocation {
  id: string;
  name: string;
  type: string;
  parent_location_id?: string | null;
  grid_rows?: number | null;
  grid_cols?: number | null;
  image_path?: string | null;
  layout?: {
    labelTemplateId?: string;
    region?: { corners: { x: number; y: number }[] } | null;
    mode?: string;
    realWidthMm?: number | null;
  } | null;
}

interface Slot {
  id: string;
  name: string;
  qr_code: string;
  slot_row: number | null;
  slot_col: number | null;
  slot_index: number | null;
  box?: { x: number; y: number; w: number; h: number } | null;
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
  const [fillOpen, setFillOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [rapidOpen, setRapidOpen] = useState(false);
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const templateId = location?.layout?.labelTemplateId;
  const template = useMemo(() => resolveTemplate(templateId), [templateId]);
  const rows = location?.grid_rows ?? 0;
  const cols = location?.grid_cols ?? 0;

  // The place (garage / shed) this space lives in — used on location labels.
  useEffect(() => {
    setPlaceName(null);
    if (!open || !location?.parent_location_id) return;
    supabase
      .from("locations")
      .select("name")
      .eq("id", location.parent_location_id)
      .maybeSingle()
      .then(({ data }) => setPlaceName((data as { name: string } | null)?.name ?? null));
  }, [open, location]);

  useEffect(() => {
    if (!open || !location) return;
    let active = true;
    (async () => {
      setLoading(true);
      setSelected(null);
      try {
        const { data: slotRows, error } = await supabase
          .from("locations")
          .select("id, name, qr_code, slot_row, slot_col, slot_index, layout")
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
          const next = (slotRows ?? []).map((s) => ({ ...s, box: (s.layout as { box?: { x: number; y: number; w: number; h: number } } | null)?.box ?? null, items: byLoc.get(s.id) ?? [] }));
          setSlots(next);
          // Keep the open slot panel in sync after a refetch (e.g. bin just filled).
          setSelected((prev) => (prev ? next.find((s) => s.id === prev.id) ?? prev : prev));
        }
      } catch (e) {
        toast({ title: "Couldn't load map", description: String((e as Error)?.message || e), variant: "destructive" });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [open, location, toast, refreshKey]);

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

  // Bin label: the slot's own name. Location label: the full path (Garage · Bin rack · R2C3).
  const locationLabelData = (slot: Slot): LabelData => ({
    ...labelData(slot),
    name: [placeName, location?.name, `R${slot.slot_row}C${slot.slot_col}`].filter(Boolean).join(" · "),
    parent: [placeName, location?.name].filter(Boolean).join(" · "),
  });

  const printOne = async (slot: Slot, kind: "bin" | "location" = "bin") => {
    const data = kind === "location" ? locationLabelData(slot) : labelData(slot);
    const res = await outputLabel(template, data);
    toast({
      title: res.success ? "Label ready" : "Print failed",
      description: res.message,
      variant: res.success ? undefined : "destructive",
    });
  };

  const printAll = async () => {
    if (!isLabelOutputSupported()) {
      toast({ title: "Printing unavailable", description: "Open the app at localhost:17777 (desktop connector) or use a Chromium browser with a Brother printer.", variant: "destructive" });
      return;
    }
    setPrintingAll(true);
    let ok = 0;
    let lastErr = "";
    for (const s of slots) {
      // printTemplateLabel prefers the desktop connector (CUPS), falls back to WebUSB.
      const res = await printTemplateLabel(template, labelData(s));
      if (res.success) ok++;
      else { lastErr = res.message; break; } // stop on first failure (e.g. out of tape / printer error)
    }
    setPrintingAll(false);
    toast({
      title: ok === slots.length ? "All labels printed" : "Batch print stopped",
      description: ok === slots.length ? `Printed ${ok} labels.` : `Printed ${ok} of ${slots.length} — ${lastErr}`,
      variant: ok === slots.length ? "success" : "destructive",
    });
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
              {isLabelOutputSupported() && slots.length > 0 && (
                <Button size="sm" variant="outline" onClick={printAll} disabled={printingAll}>
                  {printingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />}
                  Print all labels
                </Button>
              )}
            </div>

            {location?.image_path && location.layout?.mode === "spots" ? (
              /* Spot view: each item's own box drawn on the photo. Tap to open. */
              <div className="relative rounded-md overflow-hidden border">
                <img src={location.image_path} alt={`${location.name} photo`} className="w-full object-contain bg-tile" />
                <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {slots.filter((s) => s.box).map((s) => {
                    const filled = s.items.length > 0;
                    const isSel = selected?.id === s.id;
                    const b = s.box!;
                    return (
                      <rect
                        key={s.id}
                        x={b.x * 100} y={b.y * 100} width={b.w * 100} height={b.h * 100}
                        rx="0.8"
                        className="cursor-pointer"
                        fill={isSel ? "hsl(22 92% 55% / 0.5)" : filled ? "hsl(22 92% 55% / 0.28)" : "hsl(22 92% 55% / 0.08)"}
                        stroke={isSel ? "hsl(22 92% 55%)" : "rgba(255,255,255,0.7)"}
                        strokeWidth={isSel ? 0.8 : 0.4}
                        vectorEffect="non-scaling-stroke"
                        onClick={() => setSelected(s)}
                      >
                        <title>{s.name}{filled ? `: ${s.items.join(", ")}` : ""}</title>
                      </rect>
                    );
                  })}
                </svg>
              </div>
            ) : location?.image_path ? (
              /* Photo view: the slot grid drawn over the actual space (pinned to the
                 mapped quad when one was set, so cells sit on the real bins). */
              <div className="relative rounded-md overflow-hidden border">
                <img src={location.image_path} alt={`${location.name} photo`} className="w-full object-contain bg-tile" />
                <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {(() => {
                    const rc = location.layout?.region?.corners;
                    const quad: QuadCorners = rc && rc.length === 4
                      ? (rc as QuadCorners)
                      : [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
                    return Array.from({ length: rows }).flatMap((_, ri) =>
                      Array.from({ length: cols }).map((__, ci) => {
                        const r = ri + 1, c = ci + 1;
                        const slot = slotAt(r, c);
                        const filled = (slot?.items.length ?? 0) > 0;
                        const isSel = !!slot && selected?.id === slot.id;
                        return (
                          <polygon
                            key={`${r}-${c}`}
                            points={quadToSvgPoints(cellQuad(quad, r, c, rows, cols), 100, 100)}
                            className="cursor-pointer"
                            fill={isSel ? "hsl(22 92% 55% / 0.45)" : filled ? "hsl(22 92% 55% / 0.28)" : "transparent"}
                            stroke={isSel ? "hsl(22 92% 55%)" : "rgba(255,255,255,0.55)"}
                            strokeWidth={isSel ? 0.8 : 0.3}
                            vectorEffect="non-scaling-stroke"
                            onClick={() => slot && setSelected(slot)}
                          >
                            <title>{slot ? `${slot.name}${filled ? `: ${slot.items.join(", ")}` : " (empty)"}` : "no slot"}</title>
                          </polygon>
                        );
                      }),
                    );
                  })()}
                </svg>
              </div>
            ) : (
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
            )}

            {selected && (
              <div className="rounded-md border p-3 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{selected.name}</div>
                    <div className="text-xs text-muted-foreground font-mono truncate">{selected.qr_code}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setRapidOpen(true)}>
                    <Zap className="h-4 w-4 mr-2" /> Rapid Mode
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setFillOpen(true)}>
                    <Camera className="h-4 w-4 mr-2" /> Fill bin with camera
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setSortOpen(true)}>
                    <Boxes className="h-4 w-4 mr-2" /> Sort bin
                  </Button>
                  {isLabelOutputSupported() && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => printOne(selected, "bin")}>
                        <Printer className="h-4 w-4 mr-2" /> Bin label
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => printOne(selected, "location")}>
                        <MapPin className="h-4 w-4 mr-2" /> Location label
                      </Button>
                    </>
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

        <BinFillDialog
          open={fillOpen}
          onOpenChange={setFillOpen}
          bin={selected ? { id: selected.id, name: selected.name } : null}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />

        <SortBinDialog
          open={sortOpen}
          onOpenChange={setSortOpen}
          bin={selected ? { id: selected.id, name: selected.name, layout: (selected as { layout?: Record<string, unknown> | null }).layout ?? null } : null}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />

        <RapidMode
          open={rapidOpen}
          onOpenChange={setRapidOpen}
          bin={selected ? { id: selected.id, name: selected.name } : null}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />
      </DialogContent>
    </Dialog>
  );
}
