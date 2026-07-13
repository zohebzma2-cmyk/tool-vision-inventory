import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2, Save, Grid2x2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/adaptive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/** Normalized rect (0..1 of the room) for one storage zone. */
interface Rect { x: number; y: number; w: number; h: number }

interface Zone {
  id: string;
  name: string;
  type: string;
  rect: Rect;
}

export interface Blueprint {
  roomFt: { w: number; d: number };
  zones: Zone[];
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  place: { id: string; name: string; layout?: Record<string, unknown> | null } | null;
  onSaved?: () => void;
}

// Storage-zone kinds — all valid location types, each a recognizable furniture strip.
const ZONE_TYPES = ["pegboard", "shelf", "cabinet", "rack", "drawer", "bin"];
const ZONE_COLOR: Record<string, string> = {
  pegboard: "hsl(20 90% 50% / 0.22)",
  shelf: "hsl(214 70% 48% / 0.20)",
  cabinet: "hsl(152 52% 38% / 0.20)",
  rack: "hsl(38 92% 48% / 0.22)",
  drawer: "hsl(270 50% 55% / 0.20)",
  bin: "hsl(0 0% 40% / 0.18)",
};
const MIN = 0.05;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const uid = () => "z" + Math.random().toString(36).slice(2, 9);

/** Draw a place's storage layout, Roomle-style: a to-scale room with labeled zones
 * (pegboard, shelf, rack…) you drag and size on a foot grid. Saved as the place blueprint. */
export function BlueprintEditor({ open, onOpenChange, place, onSaved }: Props) {
  const { toast } = useToast();
  const [roomW, setRoomW] = useState("20");
  const [roomD, setRoomD] = useState("20");
  const [zones, setZones] = useState<Zone[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; orig: Rect } | null>(null);

  useEffect(() => {
    if (!open || !place) return;
    const bp = (place.layout as { blueprint?: Blueprint; dims?: { widthFt?: number; depthFt?: number } } | null);
    setRoomW(String(bp?.blueprint?.roomFt.w ?? bp?.dims?.widthFt ?? 20));
    setRoomD(String(bp?.blueprint?.roomFt.d ?? bp?.dims?.depthFt ?? 20));
    setZones(bp?.blueprint?.zones ?? []);
    setSelected(null);
  }, [open, place]);

  const wFt = Math.max(1, Number(roomW) || 20);
  const dFt = Math.max(1, Number(roomD) || 20);

  const addZone = () => {
    const n = zones.length;
    const off = (n % 4) * 0.05;
    const z: Zone = { id: uid(), name: `Zone ${n + 1}`, type: "pegboard", rect: { x: clamp(0.08 + off, 0, 0.6), y: clamp(0.08 + off, 0, 0.7), w: 0.28, h: 0.14 } };
    setZones((all) => [...all, z]);
    setSelected(z.id);
  };

  const setRect = (id: string, rect: Rect) => setZones((all) => all.map((z) => (z.id === id ? { ...z, rect } : z)));
  const patch = (id: string, p: Partial<Zone>) => setZones((all) => all.map((z) => (z.id === id ? { ...z, ...p } : z)));

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current, el = canvasRef.current;
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - d.sx) / r.width, dy = (e.clientY - d.sy) / r.height;
    if (d.mode === "move")
      setRect(d.id, { ...d.orig, x: clamp(d.orig.x + dx, 0, 1 - d.orig.w), y: clamp(d.orig.y + dy, 0, 1 - d.orig.h) });
    else
      setRect(d.id, { ...d.orig, w: clamp(d.orig.w + dx, MIN, 1 - d.orig.x), h: clamp(d.orig.h + dy, MIN, 1 - d.orig.y) });
  };

  const startDrag = (e: React.PointerEvent, id: string, mode: "move" | "resize", orig: Rect) => {
    e.preventDefault(); e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setSelected(id);
    drag.current = { id, mode, sx: e.clientX, sy: e.clientY, orig };
  };

  const save = async () => {
    if (!place) return;
    setSaving(true);
    try {
      const blueprint: Blueprint = { roomFt: { w: wFt, d: dFt }, zones };
      const layout = { ...((place.layout as Record<string, unknown>) ?? {}), blueprint, dims: { widthFt: wFt, depthFt: dFt } };
      const { error } = await supabase.from("locations").update({ layout }).eq("id", place.id);
      if (error) throw error;
      toast({ title: "Blueprint saved", description: `${zones.length} zone${zones.length === 1 ? "" : "s"} in ${place.name}.`, variant: "success" });
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Couldn't save blueprint", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const sel = zones.find((z) => z.id === selected) ?? null;
  // Foot grid lines — one per foot up to a sensible density.
  const gridStep = Math.max(1, Math.round(Math.max(wFt, dFt) / 20));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <Grid2x2 className="h-5 w-5" /> {place?.name} — blueprint
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="rw" className="text-xs">Room width (ft)</Label>
              <Input id="rw" type="number" inputMode="decimal" value={roomW} onChange={(e) => setRoomW(e.target.value)} className="h-10 w-24" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rd" className="text-xs">Room depth (ft)</Label>
              <Input id="rd" type="number" inputMode="decimal" value={roomD} onChange={(e) => setRoomD(e.target.value)} className="h-10 w-24" />
            </div>
            <Button size="sm" onClick={addZone}><Plus className="h-4 w-4 mr-2" /> Add zone</Button>
          </div>

          {/* The room canvas, aspect-matched to the real room so zones stay in proportion. */}
          <div
            ref={canvasRef}
            className="relative w-full rounded-lg border-2 border-tile bg-card overflow-hidden select-none touch-none"
            style={{ aspectRatio: `${wFt} / ${dFt}` }}
            onPointerMove={onMove}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
            onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
          >
            {/* foot grid */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              {Array.from({ length: Math.floor(wFt / gridStep) }).map((_, i) => (
                <line key={`v${i}`} x1={((i + 1) * gridStep / wFt) * 100} y1="0" x2={((i + 1) * gridStep / wFt) * 100} y2="100" stroke="hsl(var(--border))" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
              ))}
              {Array.from({ length: Math.floor(dFt / gridStep) }).map((_, i) => (
                <line key={`h${i}`} x1="0" y1={((i + 1) * gridStep / dFt) * 100} x2="100" y2={((i + 1) * gridStep / dFt) * 100} stroke="hsl(var(--border))" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
              ))}
            </svg>

            {zones.map((z) => {
              const zW = Math.round(z.rect.w * wFt * 10) / 10;
              const zD = Math.round(z.rect.h * dFt * 10) / 10;
              return (
                <div
                  key={z.id}
                  onPointerDown={(e) => startDrag(e, z.id, "move", z.rect)}
                  className={cn(
                    "absolute rounded border-2 flex flex-col p-1 overflow-hidden cursor-move",
                    selected === z.id ? "border-primary ring-2 ring-primary/40" : "border-tile/60",
                  )}
                  style={{
                    left: `${z.rect.x * 100}%`, top: `${z.rect.y * 100}%`,
                    width: `${z.rect.w * 100}%`, height: `${z.rect.h * 100}%`,
                    background: ZONE_COLOR[z.type] ?? ZONE_COLOR.bin,
                  }}
                >
                  <span className="font-display text-[11px] font-semibold leading-none truncate">{z.name}</span>
                  <span className="font-mono text-[9px] text-muted-foreground mt-auto">{zW}×{zD} ft</span>
                  <span
                    onPointerDown={(e) => startDrag(e, z.id, "resize", z.rect)}
                    className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
                    aria-hidden
                  >
                    <span className="absolute bottom-0.5 right-0.5 h-2 w-2 border-b-2 border-r-2 border-primary" />
                  </span>
                </div>
              );
            })}
            {zones.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground pointer-events-none">
                Add a zone, then drag it against a wall.
              </div>
            )}
          </div>

          {/* Selected-zone editor */}
          {sel && (
            <div className="rounded-lg border p-3 flex flex-wrap items-end gap-3">
              <div className="space-y-1 flex-1 min-w-[10rem]">
                <Label htmlFor="zn" className="text-xs">Zone name</Label>
                <Input id="zn" value={sel.name} onChange={(e) => patch(sel.id, { name: e.target.value })} className="h-10" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Type</Label>
                <Select value={sel.type} onValueChange={(v) => patch(sel.id, { type: v })}>
                  <SelectTrigger className="h-10 w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ZONE_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="ghost" size="icon" className="h-10 w-10 text-destructive" onClick={() => { setZones((all) => all.filter((z) => z.id !== sel.id)); setSelected(null); }}>
                <Trash2 className="h-4 w-4" />
                <span className="sr-only">Delete zone</span>
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save blueprint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
