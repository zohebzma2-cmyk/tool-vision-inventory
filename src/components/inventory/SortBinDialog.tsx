import { useEffect, useState } from "react";
import { Camera, Loader2, Plus, Trash2, Check, Printer, Boxes, ArrowRight, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/adaptive-dialog";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { compressImage } from "@/lib/image";
import { generateQRCode } from "@/lib/slots";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { sortBinFromImage, isVisionConfigured, VisionNotConfiguredError } from "@/lib/vision";
import { printLabel } from "./PrinterService";
import { isLabelOutputSupported } from "@/lib/brotherPrint";
import { VisionProgress, VISION_STAGES } from "./VisionProgress";

const KINDS = ["part", "tool", "set", "consumable"] as const;

// Real Home Depot tote sizes (Sterilite / HDX / IRIS / Rubbermaid), for the one-tap size chooser.
// Canonical capacity is quarts; small totes are shown in qt, larger ones in gal (4 qt = 1 gal).
const SIZE_PRESETS: { qt: number; unit: "qt" | "gal" }[] = [
  { qt: 6, unit: "qt" },    // shoebox
  { qt: 16, unit: "qt" },   // storage box
  { qt: 28, unit: "qt" },   // medium box
  { qt: 48, unit: "gal" },  // 12 gal tough tote
  { qt: 72, unit: "gal" },  // 18 gal large tote
  { qt: 108, unit: "gal" }, // 27 gal tough tote
  { qt: 160, unit: "gal" }, // 40 gal heavy-duty
];

/** Human label for a capacity in quarts, in the given unit. */
const sizeText = (qt: number, unit: "qt" | "gal") =>
  unit === "gal" ? `${+(qt / 4).toFixed(1)} gal` : `${qt} qt`;

interface DraftItem {
  name: string; category: string; kind: string; brand: string; model: string; quantity: number; include: boolean;
}

/** A resolved place (space or rack) we can attach a bin to and print a label for. */
interface Place { id: string; name: string; qr: string; }
interface LocRow { id: string; name: string; qr_code: string; type: string; parent_location_id: string | null; }

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** An existing bin/slot to sort. Pass null to sort NEW bins (a whole space/rack setup session). */
  bin: { id: string; name: string; layout?: Record<string, unknown> | null } | null;
  onSaved?: () => void;
}

type Step = "location" | "bin" | "saved";
const NEW = "__new";
const NONE = "__none";

/**
 * Sort bins into your garage. For a fresh session you first say WHERE you're sorting — which space
 * (garage, shed…) and which rack — then snap each bin: the AI lists what's inside and estimates the
 * tote size, you confirm, and it's stored with an easy-to-read bin number. You can print clean
 * labels for the space, the rack, and each numbered bin, then loop straight into the next bin.
 */
export function SortBinDialog({ open, onOpenChange, bin, onSaved }: Props) {
  const { toast } = useToast();
  const isNew = !bin;

  const [step, setStep] = useState<Step>(isNew ? "location" : "bin");

  // Where we're sorting (fresh sessions).
  const [spaces, setSpaces] = useState<LocRow[]>([]);
  const [racks, setRacks] = useState<LocRow[]>([]);
  const [spaceSel, setSpaceSel] = useState<string>("");
  const [newSpaceName, setNewSpaceName] = useState("");
  const [rackSel, setRackSel] = useState<string>(NONE);
  const [newRackName, setNewRackName] = useState("");
  const [ctx, setCtx] = useState<{ space?: Place; rack?: Place }>({});

  // Current bin.
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [sizeQt, setSizeQt] = useState<number>(0);       // canonical capacity in quarts
  const [sizeUnit, setSizeUnit] = useState<"qt" | "gal">("gal"); // how the size is shown/entered
  const [summary, setSummary] = useState<string>("");
  const [analyzed, setAnalyzed] = useState(false);
  const [newName, setNewName] = useState("");
  const [binNumber, setBinNumber] = useState(1);

  const [saving, setSaving] = useState(false);
  const [printingKey, setPrintingKey] = useState<string | null>(null); // which label is printing
  const [savedBin, setSavedBin] = useState<{ number: number; title: string; qr: string } | null>(null);
  // Which of the location labels have been printed this session (so we prompt for them just once).
  const [printed, setPrinted] = useState<{ space?: boolean; rack?: boolean }>({});

  const resetBinFields = () => {
    setImageDataUrl(null); setDrafts([]); setAnalyzed(false);
    setSizeQt(0); setSizeUnit("gal"); setSummary(""); setNewName(""); setSavedBin(null);
  };

  useEffect(() => {
    if (!open) return;
    setSaving(false);
    setPrinted({});
    resetBinFields();
    if (isNew) {
      setStep("location");
      setSpaceSel(""); setNewSpaceName(""); setRackSel(NONE); setNewRackName(""); setCtx({});
      (async () => {
        const { data } = await supabase
          .from("locations")
          .select("id,name,qr_code,type,parent_location_id")
          .in("type", ["space", "rack"])
          .eq("is_slot", false);
        const rows = (data as LocRow[]) || [];
        setSpaces(rows.filter((r) => r.type === "space"));
        setRacks(rows.filter((r) => r.type === "rack"));
      })();
    } else {
      setStep("bin");
      const layout = bin?.layout as { gallons?: number; quarts?: number; sizeUnit?: "qt" | "gal"; summary?: string; binNumber?: number } | null | undefined;
      setSizeQt(Number(layout?.quarts) || Math.round((Number(layout?.gallons) || 0) * 4));
      setSizeUnit(layout?.sizeUnit ?? "gal");
      setSummary(typeof layout?.summary === "string" ? layout.summary : "");
      setBinNumber(Number(layout?.binNumber) || 0);
      setCtx({});
    }
    // Depend on bin?.id (stable), NOT the bin object literal (fresh each render → would wipe state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bin?.id]);

  const close = (v: boolean) => onOpenChange(v);

  // ---- Location step -------------------------------------------------------
  const racksInSpace = racks.filter((r) => spaceSel && spaceSel !== NEW && r.parent_location_id === spaceSel);
  const spaceReady = (spaceSel && spaceSel !== NEW) || (spaceSel === NEW && newSpaceName.trim().length > 0);
  const rackReady = rackSel !== NEW || newRackName.trim().length > 0;

  const resolvePlace = async (type: string, name: string, parentId?: string): Promise<Place> => {
    const { data, error } = await supabase.from("locations").insert([{
      name, type, is_slot: false, qr_code: generateQRCode(),
      parent_location_id: parentId ?? null, layout: { placeKind: type },
    }]).select("id, name, qr_code").single();
    if (error) throw error;
    return { id: data!.id as string, name: data!.name as string, qr: data!.qr_code as string };
  };

  const fetchNextBinNumber = async (): Promise<number> => {
    const { data } = await supabase.from("locations").select("layout").eq("type", "bin");
    const max = (data || []).reduce((m, r) => {
      const n = Number((r as { layout?: { binNumber?: unknown } })?.layout?.binNumber) || 0;
      return Math.max(m, n);
    }, 0);
    return max + 1;
  };

  // Display names for the chosen space/rack — derived from the selection, so the bin-step header
  // and labels read correctly BEFORE anything is written to the DB.
  const planSpaceName = spaceSel && spaceSel !== NEW
    ? (spaces.find((s) => s.id === spaceSel)?.name ?? "Space")
    : (newSpaceName.trim() || "Garage");
  const planRackName = rackSel === NEW
    ? (newRackName.trim() || "Rack")
    : (rackSel && rackSel !== NONE ? racks.find((r) => r.id === rackSel)?.name : undefined);

  // Move to the bin step WITHOUT creating anything — so a mistyped space/rack or a Back tap leaves
  // no orphaned rows. The space/rack are created lazily on the first save (resolveCtx) and reused.
  const continueFromLocation = async () => {
    setSaving(true);
    try {
      setBinNumber(await fetchNextBinNumber());
      setStep("bin");
    } catch (e) {
      toast({ title: "Couldn't start", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // Create (once) or reuse the chosen space + rack, caching them so every bin in the session shares them.
  const resolveCtx = async (): Promise<{ space: Place; rack?: Place }> => {
    let space = ctx.space;
    if (!space) {
      space = spaceSel && spaceSel !== NEW
        ? (() => { const s = spaces.find((x) => x.id === spaceSel)!; return { id: s.id, name: s.name, qr: s.qr_code }; })()
        : await resolvePlace("space", newSpaceName.trim() || "Garage");
    }
    let rack = ctx.rack;
    if (!rack && rackSel !== NONE) {
      rack = rackSel === NEW
        ? await resolvePlace("rack", newRackName.trim() || "Rack", space.id)
        : (() => { const r = racks.find((x) => x.id === rackSel); return r ? { id: r.id, name: r.name, qr: r.qr_code } : undefined; })();
    }
    const resolved = { space, rack };
    setCtx(resolved);
    return resolved;
  };

  // ---- Bin step ------------------------------------------------------------
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
      if (tote?.gallonsGuess) { setSizeQt(Math.round(tote.gallonsGuess * 4)); setSizeUnit("gal"); }
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
  const galNum = +(sizeQt / 4).toFixed(2); // canonical gallons (for storage/back-compat)
  const sizeLabel = sizeText(sizeQt, sizeUnit);
  const binTitle = summary.trim() || newName.trim() || `Bin ${binNumber}`;

  const storeItems = async (binId: string) => {
    if (!selected.length) return;
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
      item_id: it.id, location_id: binId, quantity: (it as { quantity?: number }).quantity || 1,
    }));
    if (links.length) {
      const { error: linkErr } = await supabase.from("item_locations").insert(links);
      if (linkErr) throw linkErr;
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const { space, rack } = await resolveCtx(); // creates space/rack now (first bin) or reuses them
        const number = binNumber;
        const name = `Bin ${number}${summary.trim() || newName.trim() ? ` — ${binTitle}` : ""}`;
        const parentId = rack?.id ?? space.id;
        const { data: made, error } = await supabase.from("locations").insert([{
          name, type: "bin", is_slot: false, qr_code: generateQRCode(),
          parent_location_id: parentId,
          image_path: imageDataUrl ?? null, // the photo of the bin's contents, kept with the bin
          layout: { placeKind: "bin", binNumber: number, gallons: galNum, quarts: sizeQt, sizeUnit, summary: summary.trim(), binImage: imageDataUrl ?? undefined },
        }]).select("id, qr_code").single();
        if (error) throw error;
        await storeItems(made!.id as string);
        setSavedBin({ number, title: binTitle, qr: made!.qr_code as string });
      } else {
        // Existing bin — store items and persist size/summary/number on it.
        const binId = bin!.id;
        await storeItems(binId);
        const prior = (bin!.layout as Record<string, unknown>) ?? {};
        const number = Number((prior as { binNumber?: unknown }).binNumber) || binNumber || 0;
        const layout = { ...prior, binNumber: number || undefined, gallons: galNum, quarts: sizeQt, sizeUnit, summary: summary.trim(), binImage: imageDataUrl ?? (prior as { binImage?: string }).binImage };
        const upd: Record<string, unknown> = { layout };
        if (imageDataUrl) upd.image_path = imageDataUrl;
        const { error: upErr } = await supabase.from("locations").update(upd).eq("id", binId);
        if (upErr) throw upErr;
        const { data: row } = await supabase.from("locations").select("qr_code").eq("id", binId).single();
        setSavedBin({ number, title: summary.trim() || bin!.name, qr: (row?.qr_code as string) ?? "" });
      }

      haptic.success();
      toast({ title: "Bin sorted", description: `${selected.length} item${selected.length === 1 ? "" : "s"} stored · ${sizeLabel}.`, variant: "success" });
      setStep("saved");
      onSaved?.();
    } catch (e) {
      toast({ title: "Couldn't save the bin", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const addAnotherBin = () => {
    resetBinFields();
    setBinNumber((n) => n + 1);
    setStep("bin");
  };

  // ---- Labels --------------------------------------------------------------
  const notify = (res: { success: boolean; message: string }) => {
    const canceled = /cancel/i.test(res.message);
    toast({
      title: res.success ? "Label sent" : canceled ? "Print canceled" : "Couldn't print",
      description: res.message,
      variant: res.success ? "success" : canceled ? "default" : "destructive",
    });
  };

  const locationLine = isNew
    ? (planRackName ? `${planRackName} · ${planSpaceName}` : planSpaceName)
    : undefined;

  const runPrint = async (key: string, spec: Parameters<typeof printLabel>[0], after?: () => void) => {
    setPrintingKey(key);
    try { notify(await printLabel(spec)); after?.(); }
    finally { setPrintingKey(null); }
  };

  const printBinLabel = () =>
    savedBin && runPrint("bin", {
      badge: `Bin ${savedBin.number || ""}`.trim(),
      title: savedBin.title,
      lines: [sizeLabel, locationLine, selected.length ? `${selected.length} items` : ""].filter(Boolean) as string[],
      qr: savedBin.qr || undefined,
    });
  const printSpaceLabel = () =>
    ctx.space && runPrint("space", { title: ctx.space.name, lines: ["Space"], qr: ctx.space.qr }, () => setPrinted((p) => ({ ...p, space: true })));
  const printRackLabel = () =>
    ctx.rack && runPrint("rack", { title: ctx.rack.name, lines: [ctx.space?.name ?? "", "Rack"].filter(Boolean), qr: ctx.rack.qr }, () => setPrinted((p) => ({ ...p, rack: true })));

  // ---- Render --------------------------------------------------------------
  const heading = step === "location" ? "Where are you sorting?"
    : bin ? `Sort ${bin.name}`
    : `Bin ${binNumber}${locationLine ? ` · ${locationLine}` : ""}`;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === "location" ? <MapPin className="h-5 w-5" /> : <Boxes className="h-5 w-5" />} {heading}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Sort bins into a space and rack, confirm the contents and size, and print numbered labels.
          </DialogDescription>
        </DialogHeader>

        {isNew && <StepDots step={step} />}

        {/* STEP 1 — where are we sorting */}
        {step === "location" && (
          <div className="space-y-4 animate-in-up">
            <p className="text-sm text-muted-foreground">
              Pick the space and rack you're organizing. We'll number each bin and make labels for all of them.
            </p>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Space</label>
              <select value={spaceSel} onChange={(e) => { setSpaceSel(e.target.value); setRackSel(NONE); }}
                className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="" disabled>Choose a space…</option>
                {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                <option value={NEW}>＋ New space…</option>
              </select>
              {spaceSel === NEW && (
                <Input autoFocus value={newSpaceName} onChange={(e) => setNewSpaceName(e.target.value)} placeholder="e.g. Garage, Backyard shed" />
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Rack / shelf <span className="text-muted-foreground font-normal">(optional)</span></label>
              <select value={rackSel} onChange={(e) => setRackSel(e.target.value)} disabled={!spaceReady}
                className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50">
                <option value={NONE}>No rack — place in the space</option>
                {racksInSpace.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                <option value={NEW}>＋ New rack…</option>
              </select>
              {rackSel === NEW && (
                <Input autoFocus value={newRackName} onChange={(e) => setNewRackName(e.target.value)} placeholder="e.g. Rack A, Left wall shelf" />
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)} disabled={saving}>Cancel</Button>
              <Button onClick={continueFromLocation} disabled={saving || !spaceReady || !rackReady}>
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ArrowRight className="h-4 w-4 mr-2" />}
                Start sorting
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* STEP 2 — the bin */}
        {step === "bin" && (
          <>
            <div className="space-y-4 animate-in-up">
              {aiBusy ? (
                <VisionProgress imageDataUrl={imageDataUrl} stages={[...VISION_STAGES.identifyBin]} />
              ) : !imageDataUrl ? (
                <div className="space-y-2">
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
                  {!analyzed && (
                    <button type="button" onClick={() => { setAnalyzed(true); if (drafts.length === 0) addRow(); }}
                      className="w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                      No photo? Set the size and enter it by hand
                    </button>
                  )}
                </div>
              ) : (
                <img src={imageDataUrl} alt="Bin contents" className="w-full max-h-44 object-cover rounded-lg border" />
              )}

              {analyzed && (
                <>
                  {isNew && (
                    <div className="space-y-1.5">
                      <label htmlFor="bin-name" className="text-sm font-medium">Bin name <span className="text-muted-foreground font-normal">(optional)</span></label>
                      <Input id="bin-name" value={newName} onChange={(e) => setNewName(e.target.value)}
                        placeholder={summary.trim() ? `Bin ${binNumber} — ${summary.trim()}` : `Bin ${binNumber}`} />
                    </div>
                  )}

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Tote size {sizeQt > 0 && <span className="text-muted-foreground font-normal">(AI guess — confirm)</span>}</label>
                    <div className="flex flex-wrap items-center gap-2">
                      {SIZE_PRESETS.map((p) => (
                        <button key={p.qt} type="button" onClick={() => { setSizeQt(p.qt); setSizeUnit(p.unit); }}
                          className={cn("press rounded-md border-2 px-3 py-1.5 text-sm",
                            sizeQt === p.qt ? "border-primary bg-primary/10" : "border-tile/60")}>
                          {sizeText(p.qt, p.unit)}
                        </button>
                      ))}
                      <div className="flex items-center gap-1">
                        <Input
                          type="number" min={1} max={sizeUnit === "qt" ? 240 : 60}
                          value={sizeQt ? (sizeUnit === "qt" ? sizeQt : +(sizeQt / 4).toFixed(1)) : ""}
                          onChange={(e) => { const n = Number(e.target.value) || 0; setSizeQt(sizeUnit === "qt" ? Math.round(n) : Math.round(n * 4)); }}
                          className="h-9 w-20" placeholder={sizeUnit}
                        />
                        {/* qt / gal unit toggle */}
                        <div className="flex rounded-md border border-input overflow-hidden text-sm">
                          {(["qt", "gal"] as const).map((u) => (
                            <button key={u} type="button" onClick={() => setSizeUnit(u)}
                              className={cn("px-2.5 py-1.5", sizeUnit === u ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
                              {u}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="bin-summary" className="text-sm font-medium">What's in here (label)</label>
                    <Input id="bin-summary" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Assorted plumbing fittings" />
                  </div>

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

            <DialogFooter>
              {isNew && !ctx.space && (
                <Button variant="ghost" onClick={() => setStep("location")} disabled={saving || aiBusy}>Back</Button>
              )}
              <Button variant="outline" onClick={() => close(false)} disabled={saving}>Cancel</Button>
              {analyzed && (
                <Button onClick={save} disabled={saving || aiBusy || (selected.length === 0 && sizeQt < 1)}>
                  {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
                  Sort &amp; store{selected.length ? ` ${selected.length}` : ""}
                </Button>
              )}
            </DialogFooter>
          </>
        )}

        {/* STEP 3 — saved: labels + loop */}
        {step === "saved" && savedBin && (
          <div className="space-y-4 py-2 animate-in-up">
            <div className="flex flex-col items-center gap-2 text-center animate-pop">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="h-7 w-7" /></span>
              <p className="font-display text-lg font-semibold">Bin {savedBin.number || ""} sorted</p>
              <p className="text-sm text-muted-foreground">
                {savedBin.title}{sizeQt ? ` · ${sizeLabel}` : ""}{selected.length ? ` · ${selected.length} item${selected.length === 1 ? "" : "s"}` : ""}
                {locationLine ? ` · ${locationLine}` : ""}
              </p>
            </div>

            {isLabelOutputSupported() && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground text-center">Print labels</p>
                <div className="flex flex-col gap-2 stagger">
                  <Button onClick={printBinLabel} disabled={!!printingKey}>
                    {printingKey === "bin" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />} Bin {savedBin.number || ""} label
                  </Button>
                  {ctx.rack && (
                    <Button variant={printed.rack ? "outline" : "secondary"} onClick={printRackLabel} disabled={!!printingKey}>
                      {printingKey === "rack" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />} {printed.rack ? "Reprint" : "Print"} rack label · {ctx.rack.name}
                    </Button>
                  )}
                  {ctx.space && (
                    <Button variant={printed.space ? "outline" : "secondary"} onClick={printSpaceLabel} disabled={!!printingKey}>
                      {printingKey === "space" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />} {printed.space ? "Reprint" : "Print"} space label · {ctx.space.name}
                    </Button>
                  )}
                </div>
              </div>
            )}

            <DialogFooter className="pt-2">
              <Button variant="outline" onClick={() => close(false)}>Done</Button>
              {isNew && (
                <Button onClick={addAnotherBin}><Plus className="h-4 w-4 mr-2" /> Add another bin</Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A slim Where → Sort → Done progress row that fills in as the session advances. */
function StepDots({ step }: { step: Step }) {
  const idx = step === "location" ? 0 : step === "bin" ? 1 : 2;
  const labels = ["Where", "Sort", "Done"];
  return (
    <div className="flex items-center justify-center gap-1 pb-1">
      {labels.map((label, i) => (
        <div key={label} className="flex items-center gap-1.5">
          <span className={cn(
            "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition-all duration-300",
            i < idx ? "bg-primary text-primary-foreground"
              : i === idx ? "bg-primary/15 text-primary ring-2 ring-primary/40 tv-breathe"
              : "bg-muted text-muted-foreground",
          )}>
            {i < idx ? <Check className="h-3 w-3" /> : i + 1}
          </span>
          <span className={cn("text-xs transition-colors", i === idx ? "text-foreground font-medium" : "text-muted-foreground")}>{label}</span>
          {i < labels.length - 1 && (
            <span className={cn("mx-1 h-px w-4 sm:w-6 transition-colors duration-500", i < idx ? "bg-primary" : "bg-border")} />
          )}
        </div>
      ))}
    </div>
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
