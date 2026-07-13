import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, Map as MapIcon, Plus, Save, Scan, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/adaptive-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { compressImage } from "@/lib/image";
import { cn } from "@/lib/utils";
import { isRoomScanAvailable, scanRoom, wallsToPlan, type RoomScanResult } from "@/lib/roomScan";
import { MapSpaceDialog } from "./MapSpaceDialog";
import { BlueprintEditor } from "./BlueprintEditor";
import { ContinueOnPhone } from "./ContinueOnPhone";
import { PencilRuler } from "lucide-react";

/** Normalized rect (0..1 of the plan canvas) for one space on the floor plan. */
interface FloorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PlanSpace {
  id: string;
  name: string;
  type: string;
  layout: Record<string, unknown> | null;
  rect: FloorRect | null;
  slotCount: number;
  filledCount: number;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The place (garage, shed, …) whose floor plan this is. */
  place: { id: string; name: string; layout?: Record<string, unknown> | null } | null;
  /** Open a space's slot map from the plan. */
  onOpenSpace?: (spaceId: string) => void;
}

const MIN_SIZE = 0.08;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Birdseye floor plan of a place: spaces are draggable/resizable blocks over an
 * optional overhead photo. Tap a block (outside edit mode) to open its slot map. */
export function FloorPlanDialog({ open, onOpenChange, place, onOpenSpace }: Props) {
  const { toast } = useToast();
  const [spaces, setSpaces] = useState<PlanSpace[]>([]);
  const [floorImage, setFloorImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [lidarAvailable, setLidarAvailable] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [walls, setWalls] = useState<{ x1: number; y1: number; x2: number; y2: number }[]>([]);
  const [dims, setDims] = useState<{ widthMm: number; lengthMm: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [addSpaceOpen, setAddSpaceOpen] = useState(false);
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [phoneScanOpen, setPhoneScanOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; mode: "move" | "resize"; startX: number; startY: number; orig: FloorRect } | null>(null);

  useEffect(() => {
    if (!open || !place) return;
    setLoading(true);
    setEditMode(false);
    setDirty(false);
    setFloorImage(((place.layout as { floorImage?: string } | null)?.floorImage) ?? null);
    const scan = (place.layout as { scan?: { walls: typeof walls; widthMm: number; lengthMm: number } } | null)?.scan;
    setWalls(scan?.walls ?? []);
    setDims(scan ? { widthMm: scan.widthMm, lengthMm: scan.lengthMm } : null);
    void isRoomScanAvailable().then(setLidarAvailable);
    (async () => {
      try {
        const { data: kids, error } = await supabase
          .from("locations")
          .select("id, name, type, layout, grid_rows")
          .eq("parent_location_id", place.id)
          .eq("is_slot", false)
          .order("created_at");
        if (error) throw error;
        const spaceRows = (kids ?? []).filter((k) => k.grid_rows != null);
        const ids = spaceRows.map((k) => k.id);

        // Occupancy per space: count slots and filled slots.
        const { data: slots } = ids.length
          ? await supabase.from("locations").select("id, parent_location_id").in("parent_location_id", ids).eq("is_slot", true)
          : { data: [] as { id: string; parent_location_id: string }[] };
        const slotIds = (slots ?? []).map((s) => s.id);
        const { data: links } = slotIds.length
          ? await supabase.from("item_locations").select("location_id").in("location_id", slotIds).is("date_removed", null)
          : { data: [] as { location_id: string }[] };
        const filledSlotIds = new Set((links ?? []).map((l) => l.location_id));
        const slotsBySpace = new Map<string, { total: number; filled: number }>();
        (slots ?? []).forEach((s) => {
          const agg = slotsBySpace.get(s.parent_location_id) ?? { total: 0, filled: 0 };
          agg.total++;
          if (filledSlotIds.has(s.id)) agg.filled++;
          slotsBySpace.set(s.parent_location_id, agg);
        });

        setSpaces(spaceRows.map((k) => ({
          id: k.id,
          name: k.name,
          type: k.type,
          layout: (k.layout as Record<string, unknown>) ?? null,
          rect: ((k.layout as { floorRect?: FloorRect } | null)?.floorRect) ?? null,
          slotCount: slotsBySpace.get(k.id)?.total ?? 0,
          filledCount: slotsBySpace.get(k.id)?.filled ?? 0,
        })));
      } catch (e) {
        toast({ title: "Couldn't load the plan", description: String((e as Error)?.message || e), variant: "destructive" });
      } finally {
        setLoading(false);
      }
    })();
  }, [open, place, toast, reloadKey]);

  const placed = spaces.filter((s) => s.rect);
  const unplaced = spaces.filter((s) => !s.rect);

  const setRect = (id: string, rect: FloorRect) => {
    setSpaces((all) => all.map((s) => (s.id === id ? { ...s, rect } : s)));
    setDirty(true);
  };

  const addToPlan = (id: string) => {
    // Drop new blocks in a staggered spot near the center.
    const n = placed.length;
    setRect(id, { x: 0.3 + (n % 3) * 0.05, y: 0.3 + (n % 4) * 0.05, w: 0.3, h: 0.18 });
    setEditMode(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = canvasRef.current;
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - d.startX) / r.width;
    const dy = (e.clientY - d.startY) / r.height;
    if (d.mode === "move") {
      setRect(d.id, {
        ...d.orig,
        x: clamp(d.orig.x + dx, 0, 1 - d.orig.w),
        y: clamp(d.orig.y + dy, 0, 1 - d.orig.h),
      });
    } else {
      setRect(d.id, {
        ...d.orig,
        w: clamp(d.orig.w + dx, MIN_SIZE, 1 - d.orig.x),
        h: clamp(d.orig.h + dy, MIN_SIZE, 1 - d.orig.y),
      });
    }
  };

  const startDrag = (e: React.PointerEvent, id: string, mode: "move" | "resize", orig: FloorRect) => {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { id, mode, startX: e.clientX, startY: e.clientY, orig };
  };

  const onPickFloorPhoto = async (file?: File) => {
    if (!file) return;
    try {
      setFloorImage(await compressImage(file, 1600, 0.7));
      setDirty(true);
    } catch (e) {
      toast({ title: "Couldn't read the photo", description: String((e as Error)?.message || e), variant: "destructive" });
    }
  };

  const runScan = async () => {
    setScanning(true);
    try {
      const result: RoomScanResult = await scanRoom();
      const plan = wallsToPlan(result);
      setWalls(plan);
      setDims({ widthMm: result.footprint.widthMm, lengthMm: result.footprint.lengthMm });
      setDirty(true);
      toast({
        title: "Room scanned",
        description: `${result.walls.length} walls · ${(result.footprint.widthMm / 1000).toFixed(1)}m × ${(result.footprint.lengthMm / 1000).toFixed(1)}m`,
      });
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (!/cancel/i.test(msg)) {
        toast({ title: "Scan failed", description: msg, variant: "destructive" });
      }
    } finally {
      setScanning(false);
    }
  };

  // A scan done on the phone lands in this place's row; pull it in and show it on the plan.
  const refreshPlaceScan = async () => {
    if (!place) return;
    const { data } = await supabase.from("locations").select("layout").eq("id", place.id).single();
    const layout = (data?.layout as { scan?: { walls: typeof walls; widthMm: number; lengthMm: number }; floorImage?: string } | null) ?? null;
    if (layout?.scan) {
      setWalls(layout.scan.walls ?? []);
      setDims({ widthMm: layout.scan.widthMm, lengthMm: layout.scan.lengthMm });
    }
    if (layout?.floorImage) setFloorImage(layout.floorImage);
    toast({ title: "Room scan added", description: `${layout?.scan?.walls?.length ?? 0} walls from your iPhone.`, variant: "success" });
  };

  const save = async () => {
    if (!place) return;
    setSaving(true);
    try {
      const placeLayout = {
        ...((place.layout as Record<string, unknown>) ?? {}),
        floorImage,
        ...(dims ? { scan: { walls, widthMm: dims.widthMm, lengthMm: dims.lengthMm } } : {}),
      };
      const { error: pErr } = await supabase.from("locations").update({ layout: placeLayout }).eq("id", place.id);
      if (pErr) throw pErr;
      for (const s of spaces) {
        const layout = { ...(s.layout ?? {}), floorRect: s.rect };
        const { error } = await supabase.from("locations").update({ layout }).eq("id", s.id);
        if (error) throw error;
      }
      setDirty(false);
      setEditMode(false);
      toast({ title: "Floor plan saved", description: `${placed.length} space${placed.length === 1 ? "" : "s"} placed in ${place.name}.` });
    } catch (e) {
      toast({ title: "Couldn't save the plan", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <MapIcon className="h-5 w-5" /> {place?.name}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {spaces.length} storage location{spaces.length === 1 ? "" : "s"}
              </p>
              <Button size="sm" onClick={() => setAddSpaceOpen(true)}>
                <Plus className="h-4 w-4 mr-2" /> Add storage location
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {placed.length > 0 && (
                <Button size="sm" variant={editMode ? "default" : "outline"} onClick={() => setEditMode(!editMode)}>
                  {editMode ? "Done arranging" : "Arrange"}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setBlueprintOpen(true)}>
                <PencilRuler className="h-4 w-4 mr-2" /> Draw blueprint
              </Button>
              <Button size="sm" variant="outline" asChild>
                <label className="cursor-pointer">
                  <Camera className="h-4 w-4 mr-2" /> {floorImage ? "Replace sketch" : "Sketch / plan photo"}
                  <input type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => onPickFloorPhoto(e.target.files?.[0])} />
                </label>
              </Button>
              {lidarAvailable ? (
                <Button size="sm" variant="outline" onClick={runScan} disabled={scanning}>
                  {scanning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Scan className="h-4 w-4 mr-2" />}
                  Scan with LiDAR
                </Button>
              ) : (
                // No sensor here (desktop / non-LiDAR) — hand the scan off to the iPhone app.
                <Button size="sm" variant="outline" onClick={() => setPhoneScanOpen(true)}>
                  <Smartphone className="h-4 w-4 mr-2" /> Scan with iPhone
                </Button>
              )}
              {dirty && (
                <Button size="sm" onClick={save} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                  Save layout
                </Button>
              )}
            </div>

            {/* The plan canvas — 4:3, overhead photo or graph-paper background */}
            <div
              ref={canvasRef}
              className="relative w-full rounded-lg border overflow-hidden select-none touch-none bg-muted/40 pegboard"
              style={{ aspectRatio: "4 / 3" }}
              onPointerMove={onPointerMove}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
            >
              {floorImage && (
                <img src={floorImage} alt={`${place?.name} overhead`} className="absolute inset-0 w-full h-full object-cover opacity-90" draggable={false} />
              )}
              {walls.length > 0 && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                  {walls.map((w, i) => (
                    <line key={i} x1={w.x1 * 100} y1={w.y1 * 100} x2={w.x2 * 100} y2={w.y2 * 100}
                      stroke="hsl(var(--foreground))" strokeOpacity="0.75" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
                  ))}
                </svg>
              )}
              {placed.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${s.name}: ${s.filledCount} of ${s.slotCount} slots filled`}
                  onPointerDown={(e) => s.rect && startDrag(e, s.id, "move", s.rect)}
                  onClick={() => { if (!editMode && !drag.current) onOpenSpace?.(s.id); }}
                  className={cn(
                    "absolute label-tile border flex flex-col items-center justify-center text-center px-1 overflow-hidden",
                    editMode ? "cursor-move border-primary/70 border-dashed" : "cursor-pointer border-tile-edge hover:ring-2 hover:ring-primary",
                  )}
                  style={{
                    left: `${(s.rect?.x ?? 0) * 100}%`,
                    top: `${(s.rect?.y ?? 0) * 100}%`,
                    width: `${(s.rect?.w ?? 0.2) * 100}%`,
                    height: `${(s.rect?.h ?? 0.15) * 100}%`,
                  }}
                >
                  <span className="text-[11px] leading-tight truncate w-full">{s.name}</span>
                  <span className="font-mono text-[9px] text-tile-foreground/60 normal-case tracking-normal">
                    {s.filledCount}/{s.slotCount}
                  </span>
                  {editMode && s.rect && (
                    <span
                      onPointerDown={(e) => startDrag(e, s.id, "resize", s.rect!)}
                      className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize"
                      aria-hidden
                    >
                      <span className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 border-b-2 border-r-2 border-primary" />
                    </span>
                  )}
                </div>
              ))}
              {placed.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground px-6 text-center">
                  <span>{spaces.length === 0 ? "No storage locations here yet." : "Drag your locations onto the plan below."}</span>
                  {spaces.length === 0 && (
                    <Button size="sm" onClick={() => setAddSpaceOpen(true)}>
                      <Plus className="h-4 w-4 mr-2" /> Add a storage location
                    </Button>
                  )}
                </div>
              )}
            </div>

            {unplaced.length > 0 && (
              <div className="space-y-2">
                <p className="font-display text-xs font-semibold text-muted-foreground">
                  Not on the plan yet — tap to place
                </p>
                <div className="flex flex-wrap gap-2">
                  {unplaced.map((s) => (
                    <Button key={s.id} size="sm" variant="outline" onClick={() => addToPlan(s.id)}>
                      <Plus className="h-4 w-4 mr-1.5" /> {s.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {dims && (
              <p className="font-mono text-xs text-muted-foreground">
                Scanned: {(dims.widthMm / 1000).toFixed(2)} m × {(dims.lengthMm / 1000).toFixed(2)} m
              </p>
            )}
            {!editMode && placed.length > 0 && (
              <p className="text-xs text-muted-foreground">Tap a space to open its slot map. Use Arrange to move and resize.</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>

        <MapSpaceDialog
          open={addSpaceOpen}
          onOpenChange={setAddSpaceOpen}
          defaultPlaceId={place?.id}
          onCreated={() => { setAddSpaceOpen(false); setReloadKey((k) => k + 1); }}
        />

        <BlueprintEditor
          open={blueprintOpen}
          onOpenChange={setBlueprintOpen}
          place={place}
          onSaved={() => { setBlueprintOpen(false); setReloadKey((k) => k + 1); }}
        />

        <ContinueOnPhone
          open={phoneScanOpen}
          onOpenChange={setPhoneScanOpen}
          place={place}
          onScanArrived={refreshPlaceScan}
        />
      </DialogContent>
    </Dialog>
  );
}
