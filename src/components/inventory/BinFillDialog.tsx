import { useState } from "react";
import { Camera, Loader2, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/adaptive-dialog";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { compressImage } from "@/lib/image";
import { haptic } from "@/lib/haptics";
import { identifyBinFromImage, isVisionConfigured, VisionNotConfiguredError } from "@/lib/vision";

const KINDS = ["part", "tool", "set", "consumable"] as const;

interface DraftItem {
  name: string;
  category: string;
  kind: string;
  brand: string;
  model: string;
  quantity: number;
  include: boolean;
}

/** Flags rows whose category disagrees with the clear majority of the bin —
 * "a plumbing fitting in the electrical bin" gets pointed out during setup. */
function outlierIndexes(drafts: DraftItem[]): Set<number> {
  const included = drafts.filter((d) => d.include && d.name.trim());
  if (included.length < 3) return new Set();
  const counts = new Map<string, number>();
  included.forEach((d) => counts.set(d.category, (counts.get(d.category) || 0) + 1));
  const [topCat, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCount / included.length < 0.6) return new Set(); // no clear majority — nothing to flag
  const out = new Set<number>();
  drafts.forEach((d, i) => {
    if (d.include && d.name.trim() && d.category !== topCat) out.add(i);
  });
  return out;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The bin (slot location) being filled. */
  bin: { id: string; name: string } | null;
  onSaved?: () => void;
}

/** Photograph a bin's contents, let the AI list everything inside, review, save all to the bin. */
export function BinFillDialog({ open, onOpenChange, bin, onSaved }: Props) {
  const { toast } = useToast();
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [saving, setSaving] = useState(false);

  const reset = () => { setImageDataUrl(null); setDrafts([]); };
  const close = (v: boolean) => { if (!v) reset(); onOpenChange(v); };

  const onPickPhoto = async (file?: File) => {
    if (!file) return;
    try {
      const dataUrl = await compressImage(file);
      setImageDataUrl(dataUrl);
      const aiUrl = await compressImage(file, 960, 0.65);
      await runAI(aiUrl);
    } catch (e) {
      toast({ title: "Couldn't read the photo", description: String((e as Error)?.message || e), variant: "destructive" });
    }
  };

  const runAI = async (dataUrl?: string) => {
    const img = dataUrl ?? imageDataUrl;
    if (!img) return;
    setAiBusy(true);
    try {
      const found = await identifyBinFromImage(img);
      setDrafts(found.map((f) => ({
        name: f.name, category: f.category, kind: f.kind || "part", brand: f.brand, model: f.model,
        quantity: f.quantity || 1, include: true,
      })));
      if (found.length === 0) {
        toast({ title: "Nothing recognized", description: "Add rows by hand, or retake with more light." });
      }
    } catch (e) {
      if (e instanceof VisionNotConfiguredError) {
        toast({ title: "AI not connected", description: "Add the items by hand below." });
      } else {
        toast({ title: "Couldn't read the bin", description: String((e as Error)?.message || e), variant: "destructive" });
      }
    } finally {
      setAiBusy(false);
    }
  };

  const setDraft = (i: number, patch: Partial<DraftItem>) =>
    setDrafts((d) => d.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const addRow = () =>
    setDrafts((d) => [...d, { name: "", category: "other", kind: "part", brand: "", model: "", quantity: 1, include: true }]);

  const selected = drafts.filter((d) => d.include && d.name.trim());
  const outliers = outlierIndexes(drafts);

  const save = async () => {
    if (!bin || selected.length === 0) return;
    setSaving(true);
    try {
      const rows = selected.map((d) => ({
        name: d.name.trim(),
        category: d.category || "other",
        kind: KINDS.includes(d.kind as (typeof KINDS)[number]) ? d.kind : null,
        brand: d.brand || null,
        model: d.model || null,
        quantity: d.quantity || 1,
        quantity_unit: "piece",
      }));
      let { data: created, error } = await supabase.from("items").insert(rows).select("id");
      if (error && /kind/.test(error.message)) {
        // items.kind migration not applied yet — save everything else rather than failing.
        const withoutKind = rows.map(({ kind: _kind, ...r }) => r);
        ({ data: created, error } = await supabase.from("items").insert(withoutKind).select("id"));
      }
      if (error) throw error;

      const links = (created || []).map((it, i) => ({
        item_id: it.id,
        location_id: bin.id,
        quantity: selected[i]?.quantity || 1,
      }));
      const { error: linkErr } = await supabase.from("item_locations").insert(links);
      if (linkErr) throw linkErr;

      toast({ title: "Bin cataloged", description: `${links.length} items stored in ${bin.name}.`, variant: "success" });
      onSaved?.();
      close(false);
    } catch (e) {
      toast({ title: "Couldn't save items", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <Camera className="h-5 w-5" /> Fill {bin?.name ?? "bin"}
          </DialogTitle>
        </DialogHeader>

        {!imageDataUrl ? (
          <Button type="button" variant="outline" asChild
            className="w-full h-32 border-dashed flex-col gap-2 hover:bg-muted/50">
            <label className="cursor-pointer">
              <Camera className="h-8 w-8 text-primary" />
              <span className="font-display">Snap the bin contents</span>
              <span className="text-xs text-muted-foreground font-normal normal-case tracking-normal">
                Lay items visibly — the AI lists everything it can see
              </span>
              <input type="file" accept="image/*" capture="environment" className="hidden"
                onChange={(e) => onPickPhoto(e.target.files?.[0])} />
            </label>
          </Button>
        ) : (
          <div className="relative rounded-lg overflow-hidden border">
            <img src={imageDataUrl} alt="Bin contents" className="w-full max-h-52 object-cover" />
            <div className="absolute bottom-2 right-2 flex gap-2">
              <Button type="button" size="sm" variant="secondary" asChild>
                <label className="cursor-pointer">
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retake
                  <input type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => onPickPhoto(e.target.files?.[0])} />
                </label>
              </Button>
              {!aiBusy && (
                <Button type="button" size="sm" variant="secondary" onClick={() => runAI()}>
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Re-run AI
                </Button>
              )}
            </div>
            {aiBusy && (
              <div className="absolute inset-0 bg-tile/60 flex items-center justify-center gap-2 text-tile-foreground font-display text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Cataloging the bin…
              </div>
            )}
          </div>
        )}
        {!isVisionConfigured() && !imageDataUrl && (
          <p className="text-xs text-muted-foreground">AI isn't connected — you can still add rows by hand below.</p>
        )}

        {(drafts.length > 0 || imageDataUrl) && (
          <div className="space-y-2">
            <div className="grid grid-cols-[auto_1fr_6rem_4rem_auto] gap-2 items-center text-xs text-muted-foreground font-display px-1">
              <span /> <span>Item</span> <span>Kind</span> <span>Qty</span> <span />
            </div>
            {drafts.map((d, i) => (
              <div key={i} className="space-y-1">
                <div className="grid grid-cols-[auto_1fr_6rem_4rem_auto] gap-2 items-center">
                  <input
                    type="checkbox"
                    checked={d.include}
                    onChange={(e) => setDraft(i, { include: e.target.checked })}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                    aria-label={`Include ${d.name || "row"}`}
                  />
                  <Input value={d.name} placeholder="Item name"
                    onChange={(e) => setDraft(i, { name: e.target.value })} className="h-9" />
                  <select
                    value={d.kind}
                    onChange={(e) => setDraft(i, { kind: e.target.value })}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    aria-label="Kind"
                  >
                    {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <Input type="number" min={1} value={d.quantity}
                    onChange={(e) => setDraft(i, { quantity: Math.max(1, parseInt(e.target.value) || 1) })} className="h-9" />
                  <Button variant="ghost" size="icon" className="h-9 w-9"
                    onClick={() => setDrafts((rows) => rows.filter((_, idx) => idx !== i))}>
                    <Trash2 className="h-4 w-4" />
                    <span className="sr-only">Remove row</span>
                  </Button>
                </div>
                {outliers.has(i) && (
                  <p className="text-xs text-warning pl-6">
                    ⚠ Doesn't match the rest of this bin ({d.category}) — misfiled, or just uncheck it.
                  </p>
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="h-4 w-4 mr-2" /> Add a row
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || selected.length === 0}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
            Store {selected.length} item{selected.length === 1 ? "" : "s"} in this bin
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
