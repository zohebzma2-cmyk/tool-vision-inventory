import { useEffect, useRef, useState } from "react";
import {
  Plus, Scan, Camera, PencilRuler, Loader2, Move, Check,
  Warehouse, Home, Layers, Triangle, Hammer, DoorOpen, Box,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/adaptive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { generateQRCode } from "@/lib/slots";
import { compressImage } from "@/lib/image";
import { isRoomScanAvailable, scanRoom } from "@/lib/roomScan";
import { GuideTip } from "@/components/inventory/GuideTip";
import { cn } from "@/lib/utils";

// A recognizable top-down icon per place kind — the "generated overhead" glyph.
const PLACE_ICON: Record<string, typeof Box> = {
  garage: Warehouse,
  shed: Home,
  basement: Layers,
  attic: Triangle,
  workshop: Hammer,
  room: DoorOpen,
  space: Box,
};
const iconFor = (kind: string) => PLACE_ICON[kind?.toLowerCase()] ?? Box;
const CANVAS_ASPECT = 16 / 10; // matches the canvas aspect so real footprints stay in proportion

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Place {
  id: string;
  name: string;
  type: string;
  layout: Record<string, unknown> | null;
  plot: Plot | null;
  widthFt: number | null;
  depthFt: number | null;
  spaceCount: number;
}

const PLACE_TYPES = ["garage", "shed", "basement", "attic", "workshop", "room", "space"];
const MIN = 0.06;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));


interface Props {
  onOpenPlace: (place: { id: string; name: string; layout?: Record<string, unknown> | null }) => void;
  /** Bumped by the parent to force a reload (e.g. after a place's blueprint changes). */
  reloadSignal?: number;
}

/** Property site plan: every place (garage, shed, basement…) is a sized block on a
 * top-down plot. Add one by 3D scan, photo, or by hand; tap a block to open its interior. */
export function PropertyPlan({ onOpenPlace, reloadSignal }: Props) {
  const { toast } = useToast();
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const [arrange, setArrange] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [lidar, setLidar] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; orig: Plot } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("locations")
        .select("id, name, type, layout")
        .eq("is_slot", false)
        .is("parent_location_id", null)
        .is("grid_rows", null)
        .order("created_at");
      if (error) throw error;
      const rows = data ?? [];
      // Count spaces (mapped children) per place.
      const ids = rows.map((r) => r.id);
      const { data: kids } = ids.length
        ? await supabase.from("locations").select("parent_location_id, grid_rows").in("parent_location_id", ids)
        : { data: [] as { parent_location_id: string; grid_rows: number | null }[] };
      const countByPlace = new Map<string, number>();
      (kids ?? []).forEach((k) => {
        if (k.grid_rows != null)
          countByPlace.set(k.parent_location_id, (countByPlace.get(k.parent_location_id) ?? 0) + 1);
      });
      setPlaces(rows.map((r) => {
        const layout = (r.layout as Record<string, unknown>) ?? null;
        const plot = (layout?.plot as Plot | undefined) ?? null; // null = not yet arranged; packed at render
        const dims = layout?.dims as { widthFt?: number; depthFt?: number } | undefined;
        return {
          id: r.id, name: r.name, type: (layout?.placeKind as string) || r.type, layout,
          plot,
          widthFt: dims?.widthFt ?? null,
          depthFt: dims?.depthFt ?? null,
          spaceCount: countByPlace.get(r.id) ?? 0,
        };
      }));
    } catch (e) {
      toast({ title: "Couldn't load the property plan", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); void isRoomScanAvailable().then(setLidar); /* eslint-disable-next-line */ }, []);
  // Reload when the parent signals a change (blueprint saved, space added, etc.).
  useEffect(() => { if (reloadSignal) load(); /* eslint-disable-next-line */ }, [reloadSignal]);

  // Shared feet→canvas scale so blocks are drawn to real proportion. The largest
  // real dimension across placed spaces maps to ~30% of the canvas width.
  const dimsList = places.flatMap((p) => (p.widthFt && p.depthFt ? [p.widthFt, p.depthFt] : []));
  const maxFt = Math.max(24, ...dimsList);
  const k = 0.3 / maxFt;
  const blockSize = (p: Place): { w: number; h: number } => {
    if (p.widthFt && p.depthFt) {
      return {
        w: clamp(p.widthFt * k, 0.08, 0.6),
        h: clamp(p.depthFt * k * CANVAS_ASPECT, 0.08, 0.9),
      };
    }
    return { w: 0.18, h: 0.22 };
  };

  // Shelf-pack any place that hasn't been positioned yet, left-to-right by its real
  // footprint, wrapping down a row when it runs off the right edge.
  const positioned = (() => {
    let cx = 0.04, cy = 0.05, rowH = 0;
    return places.map((p) => {
      if (p.plot) return { p, x: p.plot.x, y: p.plot.y };
      const s = blockSize(p);
      if (cx + s.w > 0.96) { cx = 0.04; cy += rowH + 0.04; rowH = 0; }
      const pos = { p, x: cx, y: cy };
      cx += s.w + 0.04; rowH = Math.max(rowH, s.h);
      return pos;
    });
  })();

  const setPlot = (id: string, plot: Plot) => {
    setPlaces((all) => all.map((p) => (p.id === id ? { ...p, plot } : p)));
    setDirty(true);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current, el = canvasRef.current;
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - d.sx) / r.width, dy = (e.clientY - d.sy) / r.height;
    if (d.mode === "move")
      setPlot(d.id, { ...d.orig, x: clamp(d.orig.x + dx, 0, 1 - d.orig.w), y: clamp(d.orig.y + dy, 0, 1 - d.orig.h) });
    else
      setPlot(d.id, { ...d.orig, w: clamp(d.orig.w + dx, MIN, 1 - d.orig.x), h: clamp(d.orig.h + dy, MIN, 1 - d.orig.y) });
  };

  const startDrag = (e: React.PointerEvent, id: string, mode: "move" | "resize", orig: Plot) => {
    if (!arrange) return;
    e.preventDefault(); e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { id, mode, sx: e.clientX, sy: e.clientY, orig };
  };

  const save = async () => {
    setSaving(true);
    try {
      for (const p of places) {
        const layout = { ...(p.layout ?? {}), plot: p.plot };
        const { error } = await supabase.from("locations").update({ layout }).eq("id", p.id);
        if (error) throw error;
      }
      setDirty(false); setArrange(false);
      toast({ title: "Property plan saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Property plan</h2>
          <p className="text-sm text-muted-foreground">Top-down map of every place you store tools.</p>
        </div>
        <div className="flex gap-2">
          {places.length > 0 && (
            <Button size="sm" variant={arrange ? "default" : "outline"} onClick={() => (arrange ? save() : setArrange(true))} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : arrange ? <Check className="h-4 w-4 mr-2" /> : <Move className="h-4 w-4 mr-2" />}
              {arrange ? (dirty ? "Save layout" : "Done") : "Arrange"}
            </Button>
          )}
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> Add space
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : places.length === 0 ? (
        <div className="rounded-xl border border-dashed py-14 text-center">
          <PencilRuler className="h-9 w-9 mx-auto text-muted-foreground mb-3" aria-hidden />
          <h3 className="font-display text-lg font-semibold mb-1">Map your property</h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-5">
            Add each space you store things — a garage, a shed, the basement — then arrange them
            to match your lot.
          </p>
          <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4 mr-2" /> Add your first space</Button>
          <GuideTip tipKey="property-blueprint" className="mx-auto mt-6 max-w-md text-left">
            Once a space exists, tap it to draw its blueprint — or let <strong>AI draft it</strong> from
            a hand-drawn sketch or a quick description of the room.
          </GuideTip>
        </div>
      ) : (
        <div
          ref={canvasRef}
          className="relative w-full rounded-xl border bg-muted/30 pegboard overflow-hidden select-none touch-none"
          style={{ aspectRatio: "16 / 10" }}
          onPointerMove={onMove}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
        >
          {positioned.map(({ p, x, y }) => {
            const size = blockSize(p);
            const Icon = iconFor(p.type);
            const walls = (p.layout?.scan as { walls?: { x1Mm: number; z1Mm: number; x2Mm: number; z2Mm: number }[]; footprint?: { minXMm: number; minZMm: number; widthMm: number; lengthMm: number } } | undefined);
            const overhead = (p.layout?.overheadImage as string | undefined) ?? p.layout?.floorImage as string | undefined;
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => startDrag(e, p.id, "move", { x, y, ...size })}
                onClick={() => { if (!arrange && !drag.current) onOpenPlace(p); }}
                className={cn(
                  "absolute rounded-lg border-2 flex flex-col p-2.5 overflow-hidden transition-shadow animate-pop press",
                  arrange
                    ? "cursor-move border-dashed border-primary/70 bg-card/95"
                    : "cursor-pointer border-tile bg-card shadow-soft hover:shadow-md hover:border-primary",
                )}
                style={{
                  left: `${x * 100}%`, top: `${y * 100}%`,
                  width: `${size.w * 100}%`, height: `${size.h * 100}%`,
                }}
              >
                {/* Generated top-down: a drawn blueprint, a LiDAR wall outline, an
                    overhead photo, or the place icon as a clean footprint glyph. */}
                {(p.layout?.blueprint as { zones?: { rect: { x: number; y: number; w: number; h: number }; type: string }[] } | undefined)?.zones?.length ? (
                  <svg className="absolute inset-1 w-[calc(100%-0.5rem)] h-[calc(100%-0.5rem)]" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                    <rect x="1" y="1" width="98" height="98" fill="none" stroke="hsl(var(--foreground))" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    {(p.layout!.blueprint as { zones: { rect: { x: number; y: number; w: number; h: number }; type: string }[] }).zones.map((z, i) => (
                      <rect key={i} x={z.rect.x * 100} y={z.rect.y * 100} width={z.rect.w * 100} height={z.rect.h * 100}
                        fill="hsl(20 90% 50% / 0.25)" stroke="hsl(20 90% 50%)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                    ))}
                  </svg>
                ) : walls?.walls?.length && walls.footprint ? (
                  <svg className="absolute inset-1 w-[calc(100%-0.5rem)] h-[calc(100%-0.5rem)] opacity-70" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden>
                    {walls.walls.map((w, i) => {
                      const fp = walls.footprint!;
                      const sx = (v: number) => ((v - fp.minXMm) / fp.widthMm) * 100;
                      const sy = (v: number) => ((v - fp.minZMm) / fp.lengthMm) * 100;
                      return <line key={i} x1={sx(w.x1Mm)} y1={sy(w.z1Mm)} x2={sx(w.x2Mm)} y2={sy(w.z2Mm)} stroke="hsl(var(--foreground))" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
                    })}
                  </svg>
                ) : overhead ? (
                  <img src={overhead} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" aria-hidden />
                ) : (
                  <Icon className="absolute right-1.5 bottom-6 h-8 w-8 text-muted-foreground/25" aria-hidden strokeWidth={1.5} />
                )}

                <div className="relative flex items-center gap-1.5 min-w-0">
                  <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="font-display font-semibold text-sm leading-tight truncate">{p.name}</span>
                </div>
                <div className="relative mt-auto flex items-end justify-between gap-1">
                  {p.widthFt && p.depthFt ? (
                    <span className="font-mono text-[10px] text-muted-foreground bg-card/70 rounded px-1">{p.widthFt}×{p.depthFt} ft</span>
                  ) : <span />}
                  <span className="text-[10px] font-medium text-muted-foreground shrink-0 bg-card/70 rounded px-1">
                    {p.spaceCount} location{p.spaceCount === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!arrange && places.length > 0 && (
        <p className="text-xs text-muted-foreground">Tap a space to open its storage locations. Use Arrange to move and size the blocks.</p>
      )}

      <AddPlaceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        lidar={lidar}
        onCreated={() => { setAddOpen(false); load(); }}
      />
    </div>
  );
}

/** Add a place three ways, matching the sketch: 3D scan, from image, or manual draw. */
function AddPlaceDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lidar: boolean;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [method, setMethod] = useState<"pick" | "manual">("pick");
  const [name, setName] = useState("");
  const [type, setType] = useState("garage");
  const [widthFt, setWidthFt] = useState("");
  const [depthFt, setDepthFt] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => { setMethod("pick"); setName(""); setType("garage"); setWidthFt(""); setDepthFt(""); };
  const close = (v: boolean) => { if (!v) reset(); props.onOpenChange(v); };

  const createPlace = async (extra: Record<string, unknown>, dims?: { widthFt: number; depthFt: number }, imagePath?: string | null) => {
    // The DB type column is constrained; places always use the allowed "space" type
    // and carry their friendly kind (garage, shed, …) in the layout.
    const { error } = await supabase.from("locations").insert([{
      name: name.trim() || "New space",
      type: "space",
      qr_code: generateQRCode(),
      is_slot: false,
      image_path: imagePath ?? null,
      layout: { placeKind: type, ...(dims ? { dims } : {}), ...extra },
    }]);
    if (error) throw error;
  };

  const saveManual = async () => {
    setBusy(true);
    try {
      const w = widthFt ? Number(widthFt) : undefined;
      const d = depthFt ? Number(depthFt) : undefined;
      await createPlace({}, w && d ? { widthFt: w, depthFt: d } : undefined);
      toast({ title: "Place added", variant: "success" });
      reset(); props.onCreated();
    } catch (e) {
      toast({ title: "Couldn't add place", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  const fromImage = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const img = await compressImage(file, 1600, 0.7);
      await createPlace({ overheadImage: img }, undefined, img);
      toast({ title: "Place added", description: "Overhead photo attached.", variant: "success" });
      reset(); props.onCreated();
    } catch (e) {
      toast({ title: "Couldn't read the photo", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  const scan = async () => {
    setBusy(true);
    try {
      const r = await scanRoom();
      const wFt = Math.round((r.footprint.widthMm / 304.8) * 10) / 10;
      const dFt = Math.round((r.footprint.lengthMm / 304.8) * 10) / 10;
      await createPlace(
        { scan: { walls: r.walls, footprint: r.footprint } },
        { widthFt: wFt, depthFt: dFt },
      );
      toast({ title: "Place scanned", description: `${wFt} × ${dFt} ft from LiDAR.`, variant: "success" });
      reset(); props.onCreated();
    } catch (e) {
      const m = String((e as Error)?.message || e);
      if (!/cancel/i.test(m)) toast({ title: "Scan failed", description: m, variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">Add a space</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="place-name">Name</Label>
            <Input id="place-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Garage, Backyard shed" className="h-11" />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PLACE_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {method === "manual" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="w">Width (ft)</Label>
                <Input id="w" type="number" inputMode="decimal" value={widthFt} onChange={(e) => setWidthFt(e.target.value)} placeholder="20" className="h-11" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="d">Depth (ft)</Label>
                <Input id="d" type="number" inputMode="decimal" value={depthFt} onChange={(e) => setDepthFt(e.target.value)} placeholder="20" className="h-11" />
              </div>
            </div>
          ) : (
            <div>
              <Label className="text-xs text-muted-foreground">How do you want to map it?</Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
                {props.lidar && (
                  <MethodCard icon={Scan} title="3D scan" sub="Walk it with LiDAR" onClick={scan} disabled={busy || !name.trim()} />
                )}
                <MethodCard icon={Camera} title="Sketch photo" sub="Snap a paper sketch" asUpload onFile={fromImage} disabled={busy || !name.trim()} />
                <MethodCard icon={PencilRuler} title="Manual" sub="Enter size in feet" onClick={() => setMethod("manual")} disabled={busy || !name.trim()} />
              </div>
              {!name.trim() && <p className="text-xs text-muted-foreground mt-2">Name the place first.</p>}
            </div>
          )}
        </div>

        <DialogFooter>
          {method === "manual" ? (
            <>
              <Button variant="outline" onClick={() => setMethod("pick")} disabled={busy}>Back</Button>
              <Button onClick={saveManual} disabled={busy || !name.trim()}>
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />} Add place
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MethodCard(props: {
  icon: typeof Scan; title: string; sub: string;
  onClick?: () => void; disabled?: boolean; asUpload?: boolean; onFile?: (f?: File) => void;
}) {
  const Icon = props.icon;
  const inner = (
    <>
      <Icon className="h-6 w-6 text-primary mb-1.5" aria-hidden />
      <span className="font-display text-sm font-semibold">{props.title}</span>
      <span className="text-[11px] text-muted-foreground">{props.sub}</span>
    </>
  );
  const cls = "flex flex-col items-center text-center rounded-xl border p-3 hover:border-primary hover:bg-muted/40 transition-colors disabled:opacity-40";
  if (props.asUpload) {
    return (
      <Button asChild variant="ghost" className={cn(cls, "h-auto")} disabled={props.disabled}>
        <label className={props.disabled ? "pointer-events-none" : "cursor-pointer"}>
          {inner}
          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => props.onFile?.(e.target.files?.[0])} />
        </label>
      </Button>
    );
  }
  return (
    <button type="button" onClick={props.onClick} disabled={props.disabled} className={cls}>
      {inner}
    </button>
  );
}
