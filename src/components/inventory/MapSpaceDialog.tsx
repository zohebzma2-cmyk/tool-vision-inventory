import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Grid3x3, Camera, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/adaptive-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { buildSlotDefs, createSpaceWithSlots, findOrCreatePlace } from "@/lib/slots";
import { createSpaceWithSpots, spotMm, type SpotDef } from "@/lib/spots";
import { compressImage } from "@/lib/image";
import { supabase } from "@/integrations/supabase/client";
import { BUILTIN_TEMPLATES, type LabelData } from "@/lib/labelTemplates";
import { getAllTemplates, resolveTemplate } from "@/lib/customTemplates";
import { LabelTemplateRenderer } from "./LabelTemplateRenderer";
import { suggestSpaceFromImage, detectSpotsFromImage, isVisionConfigured, VisionNotConfiguredError } from "@/lib/vision";
import { cn } from "@/lib/utils";
import {
  DEFAULT_QUAD,
  quadFromBox,
  quadPoint,
  type QuadCorners,
  type Pt,
} from "@/lib/quad";

/** Drag-the-corners editor that pins the slot grid onto the photo (with perspective). */
function QuadEditor(props: {
  imageUrl: string;
  corners: QuadCorners;
  onChange: (c: QuadCorners) => void;
  rows: number;
  cols: number;
}) {
  const { imageUrl, corners, onChange, rows, cols } = props;
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };

  const lines: { a: Pt; b: Pt }[] = [];
  for (let c = 0; c <= cols; c++) {
    lines.push({ a: quadPoint(corners, c / cols, 0), b: quadPoint(corners, c / cols, 1) });
  }
  for (let r = 0; r <= rows; r++) {
    lines.push({ a: quadPoint(corners, 0, r / rows), b: quadPoint(corners, 1, r / rows) });
  }

  return (
    <div
      ref={ref}
      className="relative rounded-md overflow-hidden border select-none touch-none"
      onPointerMove={(e) => {
        if (dragging.current === null) return;
        const p = toNorm(e);
        const next = corners.map((c, i) => (i === dragging.current ? p : c)) as QuadCorners;
        onChange(next);
      }}
      onPointerUp={() => { dragging.current = null; }}
      onPointerCancel={() => { dragging.current = null; }}
    >
      <img src={imageUrl} alt="The space being mapped" className="w-full max-h-80 object-contain bg-tile" draggable={false} />
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {lines.map((l, i) => (
          <line key={i} x1={l.a.x * 100} y1={l.a.y * 100} x2={l.b.x * 100} y2={l.b.y * 100}
            stroke="hsl(22 92% 55%)" strokeWidth="0.35" strokeOpacity="0.9" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {corners.map((c, i) => (
        <button
          key={i}
          type="button"
          aria-label={`Corner ${["top-left", "top-right", "bottom-right", "bottom-left"][i]}`}
          onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); dragging.current = i; }}
          className="absolute h-11 w-11 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
          style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
        >
          <span className="h-5 w-5 rounded-full bg-primary border-2 border-white shadow" />
        </button>
      ))}
    </div>
  );
}

const SPACE_TYPES = ["pegboard", "drawer", "shelf", "bin", "cabinet", "rack", "board", "wall", "toolbox", "tool bag", "space"];

// One-tap starters for a new place. Anything else via the inline input.
const PLACE_PRESETS = ["Garage", "Shed", "Basement", "Attic", "Workshop"];

const NAMING_PRESETS = [
  { label: "Name + coords (Pegboard R2C3)", value: "{{parent}} {{slot}}" },
  { label: "Padded (Pegboard-02-03)", value: "{{parent}}-{{row}}-{{col}}" },
  { label: "Sequential (Pegboard #012)", value: "{{parent}} #{{index}}" },
  { label: "Coords only (R2C3)", value: "{{slot}}" },
];

interface Place {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: () => void;
}

export function MapSpaceDialog({ open, onOpenChange, onCreated }: Props) {
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [type, setType] = useState("pegboard");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [gridRows, setGridRows] = useState(4);
  const [gridCols, setGridCols] = useState(5);
  const [corners, setCorners] = useState<QuadCorners>(DEFAULT_QUAD);
  const [mode, setMode] = useState<"grid" | "spots">("grid");
  const [spots, setSpots] = useState<SpotDef[]>([]);
  const [spotsBusy, setSpotsBusy] = useState(false);
  const [realWidthMm, setRealWidthMm] = useState<string>("");
  const [namingScheme, setNamingScheme] = useState(NAMING_PRESETS[0].value);
  const [pad, setPad] = useState(true);
  const [templateId, setTemplateId] = useState(BUILTIN_TEMPLATES[0].id);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Places (garage / shed / …) — one tap to pick, one tap to create.
  const [places, setPlaces] = useState<Place[]>([]);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [newPlaceName, setNewPlaceName] = useState("");
  const [addingPlace, setAddingPlace] = useState(false);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const { data } = await supabase
        .from("locations")
        .select("id, name")
        .eq("is_slot", false)
        .is("parent_location_id", null)
        .is("grid_rows", null)
        .order("name");
      setPlaces((data as Place[]) || []);
    })();
  }, [open]);

  const placeName = places.find((p) => p.id === placeId)?.name ?? newPlaceName.trim();

  // Auto-name: "Garage pegboard" — until the user edits the field themselves.
  const autoName = placeName ? `${placeName} ${type}` : "";
  const effectiveName = nameTouched ? name : (name || autoName);

  const reset = () => {
    setStep(1); setName(""); setNameTouched(false); setType("pegboard"); setImageDataUrl(null);
    setGridRows(4); setGridCols(5); setNamingScheme(NAMING_PRESETS[0].value); setPad(true);
    setTemplateId(BUILTIN_TEMPLATES[0].id); setAiNote(null); setCorners(DEFAULT_QUAD);
    setMode("grid"); setSpots([]); setRealWidthMm("");
    setPlaceId(null); setNewPlaceName(""); setAddingPlace(false);
  };

  const close = (v: boolean) => { if (!v) reset(); onOpenChange(v); };

  const slotDefs = useMemo(
    () => buildSlotDefs({ rows: gridRows, cols: gridCols, namingScheme, parentName: effectiveName || "Space", pad }),
    [gridRows, gridCols, namingScheme, effectiveName, pad],
  );

  const previewData: LabelData = useMemo(() => {
    const d = slotDefs[0];
    return {
      name: d?.name ?? effectiveName,
      parent: effectiveName || "Space",
      type,
      slot: "R1C1",
      row: pad ? "01" : "1",
      col: pad ? "01" : "1",
      index: pad ? "001" : "1",
      qr: d?.qr_code ?? "LOC-PREVIEW",
    };
  }, [slotDefs, effectiveName, type, pad]);

  // Photo pick → compress → auto-run the AI so the user's next tap is already "looks right".
  const onPickPhoto = async (file?: File) => {
    if (!file) return;
    try {
      const dataUrl = await compressImage(file);
      setImageDataUrl(dataUrl);
      // The AI gets a smaller copy — vision cost scales steeply with resolution, and
      // 960px is plenty for rack geometry. The stored photo stays high-res.
      if (isVisionConfigured()) {
        const aiUrl = await compressImage(file, 960, 0.65);
        void runAISuggest(aiUrl);
      }
    } catch (e) {
      toast({ title: "Couldn't read the photo", description: String((e as Error)?.message || e), variant: "destructive" });
    }
  };

  const runAISuggest = async (dataUrl?: string) => {
    const img = dataUrl ?? imageDataUrl;
    if (!img) return;
    setAiBusy(true);
    setAiNote(null);
    try {
      const s = await suggestSpaceFromImage(img, type);
      if (s.gridRows) setGridRows(s.gridRows);
      if (s.gridCols) setGridCols(s.gridCols);
      if (s.type) setType(s.type);
      setCorners(s.region ? quadFromBox(s.region) : DEFAULT_QUAD);
      setAiNote(
        `AI read this as a ${s.gridRows ?? gridRows} × ${s.gridCols ?? gridCols} ${s.type ?? type}` +
        (s.notes ? ` — ${s.notes}` : "") + ". Adjust anything that looks off.",
      );
    } catch (e) {
      if (e instanceof VisionNotConfiguredError) {
        setAiNote("AI mapping isn't connected — set the grid manually below.");
      } else {
        toast({ title: "Couldn't analyze photo", description: String((e as Error)?.message || e), variant: "destructive" });
      }
    } finally {
      setAiBusy(false);
    }
  };

  const detectSpots = async () => {
    if (!imageDataUrl) return;
    setSpotsBusy(true);
    try {
      const found = await detectSpotsFromImage(imageDataUrl);
      setSpots(found.map((f) => ({ label: f.label, box: f.box })));
      setMode("spots");
      setAiNote(
        found.length
          ? `AI found ${found.length} individual spots. Delete any that are wrong, or drag corners in Grid mode instead.`
          : "No individual items detected — try Grid mode, or a closer photo.",
      );
    } catch (e) {
      if (e instanceof VisionNotConfiguredError) setAiNote("AI isn't connected — use Grid mode.");
      else toast({ title: "Couldn't detect spots", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setSpotsBusy(false);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      let parentLocationId: string | null = placeId;
      if (!parentLocationId && newPlaceName.trim()) {
        const place = await findOrCreatePlace(newPlaceName);
        parentLocationId = place.id;
      }
      if (mode === "spots") {
        const widthMm = realWidthMm ? Number(realWidthMm) : null;
        const { spots: made } = await createSpaceWithSpots({
          name: effectiveName, type, imagePath: imageDataUrl, parentLocationId,
          labelTemplateId: templateId, spots,
          realWidthMm: widthMm,
          realHeightMm: widthMm ? Math.round(widthMm * 0.6) : null,
        });
        toast({ title: "Space mapped", description: `Created "${effectiveName}" with ${made.length} spots.` });
        onCreated?.();
        close(false);
        return;
      }
      const { slots } = await createSpaceWithSlots({
        name: effectiveName, type, gridRows, gridCols, imagePath: imageDataUrl,
        namingScheme, labelTemplateId: templateId, pad, parentLocationId,
        region: imageDataUrl ? { corners } : null,
      });
      toast({ title: "Space mapped", description: `Created "${effectiveName}" with ${slots.length} slots.` });
      onCreated?.();
      close(false);
    } catch (e) {
      toast({ title: "Failed to create space", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const capCells = 60; // cap the rendered grid preview for very large spaces

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display uppercase tracking-wide">
            <Grid3x3 className="h-5 w-5" /> Map a space
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-5">
            {/* 1. The photo — the whole flow starts with the camera */}
            {imageDataUrl ? (
              <div className="relative rounded-lg overflow-hidden border">
                <img src={imageDataUrl} alt="The space being mapped" className="w-full max-h-64 object-cover" />
                <div className="absolute bottom-2 right-2 flex gap-2">
                  <Button type="button" size="sm" variant="secondary" asChild>
                    <label className="cursor-pointer">
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retake
                      <input type="file" accept="image/*" capture="environment" className="hidden"
                        onChange={(e) => onPickPhoto(e.target.files?.[0])} />
                    </label>
                  </Button>
                </div>
                {aiBusy && (
                  <div className="absolute inset-0 bg-tile/60 flex items-center justify-center gap-2 text-tile-foreground font-display uppercase tracking-wide text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Reading the space…
                  </div>
                )}
              </div>
            ) : (
              <Button type="button" variant="outline" asChild
                className="w-full h-32 border-dashed flex-col gap-2 hover:bg-muted/50">
                <label className="cursor-pointer">
                  <Camera className="h-8 w-8 text-primary" />
                  <span className="font-display uppercase tracking-wide">Snap the space</span>
                  <span className="text-xs text-muted-foreground font-normal normal-case tracking-normal">
                    Pegboard, drawer, shelf — the AI maps it into slots
                  </span>
                  <input type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => onPickPhoto(e.target.files?.[0])} />
                </label>
              </Button>
            )}
            {aiNote && <p className="text-sm text-muted-foreground">{aiNote}</p>}

            {/* 2. Where is it? One tap. */}
            <div className="space-y-2">
              <Label>Where is it?</Label>
              <div className="flex flex-wrap gap-2">
                {places.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { setPlaceId(placeId === p.id ? null : p.id); setNewPlaceName(""); setAddingPlace(false); }}
                    className={cn(
                      "label-tile px-3 py-1.5 text-xs transition-opacity",
                      placeId === p.id ? "ring-2 ring-primary" : "opacity-60 hover:opacity-100",
                    )}
                  >
                    {p.name}
                  </button>
                ))}
                {PLACE_PRESETS.filter(
                  (n) => !places.some((p) => p.name.toLowerCase() === n.toLowerCase()),
                ).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => { setNewPlaceName(newPlaceName === n ? "" : n); setPlaceId(null); setAddingPlace(false); }}
                    className={cn(
                      "px-3 py-1.5 text-xs rounded border border-dashed transition-colors",
                      newPlaceName === n ? "border-primary text-primary" : "text-muted-foreground hover:border-foreground/40",
                    )}
                  >
                    + {n}
                  </button>
                ))}
                {addingPlace ? (
                  <Input
                    autoFocus
                    value={newPlaceName}
                    onChange={(e) => { setNewPlaceName(e.target.value); setPlaceId(null); }}
                    onKeyDown={(e) => e.key === "Enter" && setAddingPlace(false)}
                    placeholder="Place name"
                    className="h-8 w-36 text-xs"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => { setAddingPlace(true); setNewPlaceName(""); setPlaceId(null); }}
                    className="px-3 py-1.5 text-xs rounded border border-dashed text-muted-foreground hover:border-foreground/40"
                  >
                    <Plus className="h-3 w-3 inline mr-1" />
                    Other
                  </button>
                )}
              </div>
            </div>

            {/* 3. Name + type — pre-filled, editable */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="space-name">Name</Label>
                <Input id="space-name" value={effectiveName}
                  onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
                  placeholder={autoName || "e.g., East wall pegboard"} />
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SPACE_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rows">Rows</Label>
                <Input id="rows" type="number" min={1} max={40} value={gridRows}
                  onChange={(e) => setGridRows(Math.max(1, Math.min(40, parseInt(e.target.value) || 1)))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cols">Columns</Label>
                <Input id="cols" type="number" min={1} max={40} value={gridCols}
                  onChange={(e) => setGridCols(Math.max(1, Math.min(40, parseInt(e.target.value) || 1)))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Slot naming</Label>
              <Select value={NAMING_PRESETS.some((p) => p.value === namingScheme) ? namingScheme : "custom"}
                onValueChange={(v) => v !== "custom" && setNamingScheme(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {NAMING_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
              <Input value={namingScheme} onChange={(e) => setNamingScheme(e.target.value)}
                placeholder="Tokens: {{parent}} {{row}} {{col}} {{index}} {{slot}}" className="font-mono text-xs" />
              <div className="flex items-center gap-2 pt-1">
                <Switch id="pad" checked={pad} onCheckedChange={setPad} />
                <Label htmlFor="pad" className="text-sm font-normal">Zero-pad numbers (01, 02…)</Label>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Preview — {gridRows * gridCols} slots</Label>
              {mode === "spots" && imageDataUrl ? (
                <div className="space-y-3">
                  <div className="relative rounded-md overflow-hidden border">
                    <img src={imageDataUrl} alt="The space with detected spots" className="w-full max-h-80 object-contain bg-tile" />
                    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                      {spots.map((sp, i) => (
                        <rect
                          key={i}
                          x={sp.box.x * 100} y={sp.box.y * 100}
                          width={sp.box.w * 100} height={sp.box.h * 100}
                          fill="hsl(22 92% 55% / 0.18)" stroke="hsl(22 92% 55%)" strokeWidth="0.4"
                          vectorEffect="non-scaling-stroke"
                        >
                          <title>{sp.label}</title>
                        </rect>
                      ))}
                    </svg>
                  </div>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {spots.map((sp, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          value={sp.label}
                          onChange={(e) => setSpots((all) => all.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                          className="h-9"
                        />
                        {realWidthMm && Number(realWidthMm) > 0 && (
                          <span className="font-mono text-[11px] text-muted-foreground shrink-0 w-24 text-right">
                            {(() => {
                              const m = spotMm(sp.box, Number(realWidthMm), Number(realWidthMm) * 0.6);
                              return `${m.xMm}×${m.yMm}mm`;
                            })()}
                          </span>
                        )}
                        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0"
                          onClick={() => setSpots((all) => all.filter((_, j) => j !== i))}>
                          ×
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="real-width">Board width in mm (optional — gives every spot real coordinates)</Label>
                    <Input id="real-width" type="number" inputMode="numeric" placeholder="e.g. 813 for a 32 in panel"
                      value={realWidthMm} onChange={(e) => setRealWidthMm(e.target.value)} className="h-10" />
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setMode("grid")}>Use a grid instead</Button>
                </div>
              ) : imageDataUrl ? (
                <div className="space-y-2">
                  <QuadEditor
                    imageUrl={imageDataUrl}
                    corners={corners}
                    onChange={setCorners}
                    rows={gridRows}
                    cols={gridCols}
                  />
                  <p className="text-xs text-muted-foreground">
                    Drag the orange corners onto the corners of the actual rack — the grid follows
                    the photo's perspective and every cell lands on its real bin.
                  </p>
                </div>
              ) : (
                <div className="grid gap-1 rounded-md border p-2 bg-muted/30"
                  style={{ gridTemplateColumns: `repeat(${Math.min(gridCols, 8)}, minmax(0, 1fr))` }}>
                  {slotDefs.slice(0, capCells).map((d) => (
                    <div key={d.slot_index} className="text-[10px] leading-tight bg-background rounded px-1 py-1 border truncate" title={d.name}>
                      {d.name}
                    </div>
                  ))}
                </div>
              )}
              {slotDefs.length > capCells && !imageDataUrl && (
                <p className="text-xs text-muted-foreground">…and {slotDefs.length - capCells} more.</p>
              )}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Label template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {getAllTemplates().map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{resolveTemplate(templateId).description}</p>
            </div>
            <div className="space-y-2">
              <Label>Sample slot label</Label>
              <div className="flex justify-center rounded-md border p-4 bg-muted/30">
                <LabelTemplateRenderer template={resolveTemplate(templateId)} data={previewData} pxPerMm={5} />
              </div>
            </div>
            <div className="rounded-md border p-3 text-sm text-muted-foreground">
              Creating <span className="font-medium text-foreground">{effectiveName || "(unnamed)"}</span>
              {placeName && <> in <span className="font-medium text-foreground">{placeName}</span></>} as a{" "}
              <span className="font-medium text-foreground">{gridRows}×{gridCols}</span> {type} —{" "}
              <span className="font-medium text-foreground">{gridRows * gridCols} slots</span>, each with its own QR label.
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step > 1 && <Button variant="outline" onClick={() => setStep(step - 1)} disabled={creating || aiBusy}>Back</Button>}
          {step === 1 && (
            <>
              {imageDataUrl && !aiBusy && (
                <Button variant="secondary" onClick={detectSpots} disabled={spotsBusy}>
                  {spotsBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                  Detect items
                </Button>
              )}
              <Button onClick={() => setStep(2)} disabled={!effectiveName.trim() || aiBusy}>Next</Button>
            </>
          )}
          {step === 2 && <Button onClick={() => setStep(3)} disabled={mode === "spots" ? spots.length === 0 : (gridRows < 1 || gridCols < 1)}>Next</Button>}
          {step === 3 && (
            <Button onClick={create} disabled={creating || !effectiveName.trim()}>
              {creating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Grid3x3 className="h-4 w-4 mr-2" />}
              Create {mode === "spots" ? `${spots.length} spots` : `${gridRows * gridCols} slots`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
