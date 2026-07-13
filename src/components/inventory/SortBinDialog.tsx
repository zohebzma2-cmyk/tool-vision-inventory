import { useEffect, useState } from "react";
import { Camera, Loader2, Plus, Trash2, Check, Printer, Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/adaptive-dialog";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { compressImage } from "@/lib/image";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { sortBinFromImage, isVisionConfigured, VisionNotConfiguredError } from "@/lib/vision";
import { isPrintingSupported, printTextLabel } from "./PrinterService";
import { VisionProgress, VISION_STAGES } from "./VisionProgress";

const KINDS = ["part", "tool", "set", "consumable"] as const;

// Common tote sizes (US), for the one-tap size chooser.
const SIZE_PRESETS: { label: string; gal: number }[] = [
  { label: "Small", gal: 5 },
  { label: "Medium", gal: 12 },
  { label: "Large", gal: 27 },
];

interface DraftItem {
  name: string; category: string; kind: string; brand: string; model: string; quantity: number; include: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The bin being sorted (an existing bin/slot location). */
  bin: { id: string; name: string; layout?: Record<string, unknown> | null } | null;
  onSaved?: () => void;
}

/**
 * Sort a bin: snap the inside of a tote, the AI lists what's in it AND estimates the tote size,
 * the user confirms the size in gallons, then everything is stored in the bin and a general
 * "what's in here" label is offered. Contents/size/summary persist on the bin's layout.
 */
export function SortBinDialog({ open, onOpenChange, bin, onSaved }: Props) {
  const { toast } = useToast();
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [gallons, setGallons] = useState<string>("");
  const [summary, setSummary] = useState<string>("");
  const [analyzed, setAnalyzed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null); // set after a successful save

  useEffect(() => {
    if (!open) return;
    // Prefill from any prior sort of this bin.
    const layout = bin?.layout as { gallons?: number; summary?: string } | null | undefined;
    setImageDataUrl(null); setDrafts([]); setAnalyzed(false); setSaving(false); setSavedName(null);
    setGallons(layout?.gallons ? String(layout.gallons) : "");
    setSummary(typeof layout?.summary === "string" ? layout.summary : "");
    // Depend on bin?.id (stable), NOT the bin object — the parent passes a fresh object literal
    // every render, which would otherwise re-fire this reset and wipe the photo/analysis.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bin?.id]);

  const close = (v: boolean) => { onOpenChange(v); };

  const onPickPhoto = async (file?: File) => {
    if (!file) return;
    try {
      setImageDataUrl(await compressImage(file));
      const aiUrl = await compressImage(file, 960, 0.65);
      await runAI(aiUrl);
    } catch (e) {
      toast({ title: "Couldn't read the photo", description: String((e as Error)?.message || e), variant: "destructive" });
    }
  };

  const runAI = async (dataUrl: string) => {
    setAiBusy(true);
    try {
      const { items, tote, summary: aiSummary } = await sortBinFromImage(dataUrl);
      setDrafts(items.map((f) => ({
        name: f.name, category: f.category, kind: f.kind || "part", brand: f.brand, model: f.model,
        quantity: f.quantity || 1, include: true,
      })));
      if (tote?.gallonsGuess) setGallons(String(tote.gallonsGuess));
      // Prefer the AI's overall summary; else derive from the dominant category.
      setSummary(aiSummary || deriveSummary(items.map((i) => i.category)));
      setAnalyzed(true);
      if (items.length === 0) toast({ title: "Nothing recognized", description: "Add rows by hand, or retake with more light." });
    } catch (e) {
      setAnalyzed(true);
      if (e instanceof VisionNotConfiguredError) toast({ title: "AI not connected", description: "Add items by hand and set the size below." });
      else toast({ title: "Couldn't read the bin", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setAiBusy(false);
    }
  };

  const setDraft = (i: number, patch: Partial<DraftItem>) =>
    setDrafts((d) => d.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const addRow = () =>
    setDrafts((d) => [...d, { name: "", category: "other", kind: "part", brand: "", model: "", quantity: 1, include: true }]);

  const selected = drafts.filter((d) => d.include && d.name.trim());
  const galNum = Math.max(1, Math.min(55, Number(gallons) || 0));

  const save = async () => {
    if (!bin) return;
    setSaving(true);
    try {
      // 1) Store the items in the bin (identity-mapped quantity, order-independent).
      if (selected.length) {
        const rows = selected.map((d) => ({
          name: d.name.trim(), category: d.category || "other",
          kind: KINDS.includes(d.kind as (typeof KINDS)[number]) ? d.kind : null,
          brand: d.brand || null, model: d.model || null, quantity: d.quantity || 1, quantity_unit: "piece",
        }));
        let { data: created, error } = await supabase.from("items").insert(rows).select("id, quantity");
        if (error && /kind/.test(error.message)) {
          const withoutKind = rows.map(({ kind: _k, ...r }) => r);
          ({ data: created, error } = await supabase.from("items").insert(withoutKind).select("id, quantity"));
        }
        if (error) throw error;
        const links = (created || []).map((it) => ({
          item_id: it.id, location_id: bin.id, quantity: (it as { quantity?: number }).quantity || 1,
        }));
        if (links.length) {
          const { error: linkErr } = await supabase.from("item_locations").insert(links);
          if (linkErr) throw linkErr;
        }
      }
      // 2) Persist the size + summary on the bin.
      const layout = { ...((bin.layout as Record<string, unknown>) ?? {}), gallons: galNum, summary: summary.trim() };
      const { error: upErr } = await supabase.from("locations").update({ layout }).eq("id", bin.id);
      if (upErr) throw upErr;

      haptic.success();
      setSavedName(bin.name);
      toast({ title: "Bin sorted", description: `${selected.length} item${selected.length === 1 ? "" : "s"} stored · ${galNum} gal.`, variant: "success" });
      onSaved?.();
    } catch (e) {
      toast({ title: "Couldn't save the bin", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const printLabel = async () => {
    if (!bin) return;
    const text = [bin.name, `${galNum} gal`, summary.trim()].filter(Boolean).join("\n");
    const res = await printTextLabel(text);
    toast({
      title: res.success ? "Label sent" : "Couldn't print",
      description: res.message,
      variant: res.success ? "success" : "destructive",
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Boxes className="h-5 w-5" /> Sort {bin?.name ?? "bin"}</DialogTitle>
        </DialogHeader>

        {savedName ? (
          // Success state — offer the general-contents label.
          <div className="flex flex-col items-center gap-3 py-6 text-center animate-pop">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="h-7 w-7" /></span>
            <p className="font-display text-lg font-semibold">{savedName} sorted</p>
            <p className="text-sm text-muted-foreground">{galNum} gal · {selected.length} item{selected.length === 1 ? "" : "s"}{summary.trim() ? ` · ${summary.trim()}` : ""}</p>
            {isPrintingSupported() && (
              <Button className="mt-2" onClick={printLabel}><Printer className="h-4 w-4 mr-2" /> Print bin label</Button>
            )}
            <Button variant="outline" onClick={() => close(false)}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {aiBusy ? (
              <VisionProgress imageDataUrl={imageDataUrl} stages={[...VISION_STAGES.identifyBin]} />
            ) : !imageDataUrl ? (
              <Button type="button" variant="outline" asChild className="w-full h-32 border-dashed flex-col gap-2 hover:bg-muted/50">
                <label className="cursor-pointer">
                  <Camera className="h-8 w-8 text-primary" />
                  <span className="font-display">Snap the inside of the bin</span>
                  <span className="text-xs text-muted-foreground font-normal normal-case tracking-normal">
                    AI lists what's inside and estimates the tote size
                  </span>
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onPickPhoto(e.target.files?.[0])} />
                </label>
              </Button>
            ) : (
              <img src={imageDataUrl} alt="Bin contents" className="w-full max-h-44 object-cover rounded-lg border" />
            )}

            {analyzed && (
              <>
                {/* Tote size — one-tap presets prefilled from the AI guess, editable in gallons. */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Tote size {gallons && <span className="text-muted-foreground font-normal">(AI guess — confirm)</span>}</label>
                  <div className="flex flex-wrap items-center gap-2">
                    {SIZE_PRESETS.map((p) => (
                      <button key={p.label} type="button" onClick={() => setGallons(String(p.gal))}
                        className={cn("press rounded-md border-2 px-3 py-1.5 text-sm",
                          Number(gallons) === p.gal ? "border-primary bg-primary/10" : "border-tile/60")}>
                        {p.label} · {p.gal} gal
                      </button>
                    ))}
                    <div className="flex items-center gap-1">
                      <Input type="number" min={1} max={55} value={gallons} onChange={(e) => setGallons(e.target.value)} className="h-9 w-20" placeholder="gal" />
                      <span className="text-sm text-muted-foreground">gal</span>
                    </div>
                  </div>
                </div>

                {/* General summary for the label. */}
                <div className="space-y-1.5">
                  <label htmlFor="bin-summary" className="text-sm font-medium">What's in here (label)</label>
                  <Input id="bin-summary" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Assorted plumbing fittings" />
                </div>

                {/* Contents review */}
                <div className="space-y-2">
                  <div className="grid grid-cols-[auto_1fr_6rem_4rem_auto] gap-2 items-center text-xs text-muted-foreground font-display px-1">
                    <span /> <span>Item</span> <span>Kind</span> <span>Qty</span> <span />
                  </div>
                  {drafts.map((d, i) => (
                    <div key={i} className="grid grid-cols-[auto_1fr_6rem_4rem_auto] gap-2 items-center">
                      <input type="checkbox" checked={d.include} onChange={(e) => setDraft(i, { include: e.target.checked })}
                        className="h-4 w-4 accent-[hsl(var(--primary))]" aria-label={`Include ${d.name || "row"}`} />
                      <Input value={d.name} placeholder="Item name" onChange={(e) => setDraft(i, { name: e.target.value })} className="h-9" />
                      <select value={d.kind} onChange={(e) => setDraft(i, { kind: e.target.value })}
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm" aria-label="Kind">
                        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                      <Input type="number" min={1} value={d.quantity}
                        onChange={(e) => setDraft(i, { quantity: Math.max(1, parseInt(e.target.value) || 1) })} className="h-9" />
                      <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => setDrafts((rows) => rows.filter((_, idx) => idx !== i))}>
                        <Trash2 className="h-4 w-4" /><span className="sr-only">Remove row</span>
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={addRow}><Plus className="h-4 w-4 mr-2" /> Add a row</Button>
                </div>
              </>
            )}

            {!isVisionConfigured() && !imageDataUrl && (
              <p className="text-xs text-muted-foreground">AI isn't connected — you can still add rows and set the size by hand.</p>
            )}
          </div>
        )}

        {!savedName && (
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={saving}>Cancel</Button>
            {!analyzed && !imageDataUrl && isVisionConfigured() ? null : (
              <Button onClick={save} disabled={saving || aiBusy || (selected.length === 0 && !galNum)}>
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
                Sort &amp; store{selected.length ? ` ${selected.length}` : ""}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Fallback summary from the most common category when the model doesn't return one. */
function deriveSummary(categories: string[]): string {
  if (!categories.length) return "";
  const counts = new Map<string, number>();
  categories.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return `Assorted ${top}`;
}
