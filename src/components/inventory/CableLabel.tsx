// Label a cord/cable. Hold a wrapped-up cord to the camera; the AI estimates its type + length from
// the coil (rough — you confirm/adjust), then it files the cord and prints a small tag to attach at
// the cord's end for easy tracking. Length from a coil is approximate, so the estimate is editable
// and shows the AI's range.

import { useEffect, useRef, useState } from "react";
import { X, Loader2, Camera, Check, Cable, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { haptic } from "@/lib/haptics";
import { identifyCableFromImage, isVisionConfigured, type CableEstimate } from "@/lib/vision";
import { persistInventoryImage } from "@/lib/imageStorage";
import { mintShortCode } from "@/lib/shortcode";
import { noteSessionItem } from "@/lib/sessionPrints";
import { renderItemLabel } from "@/lib/itemLabel";
import { getLabelMedia } from "@/components/inventory/PrinterService";
import { isLabelOutputSupported } from "@/lib/brotherPrint";
import { printResilient } from "@/lib/printQueue";

function grabFrame(video: HTMLVideoElement, maxW = 1024, q = 0.75): string {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.min(1, maxW / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.round(vw * s); c.height = Math.round(vh * s);
  c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", q);
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function CableLabel({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved?: () => void }) {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [step, setStep] = useState<"camera" | "review" | "saving">("camera");
  const [frame, setFrame] = useState<string | null>(null);
  const [est, setEst] = useState<CableEstimate | null>(null);
  const [type, setType] = useState("");
  const [len, setLen] = useState("");
  const [gauge, setGauge] = useState("");
  const [connectors, setConnectors] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setStep("camera"); setFrame(null); setEst(null); setType(""); setLen(""); setGauge(""); setConnectors(""); setErr("");
    let alive = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
      } catch (e) {
        setErr(`Camera unavailable: ${String((e as Error)?.message || e)}`);
      }
    })();
    return () => { alive = false; streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  }, [open]);

  const capture = async () => {
    const v = videoRef.current;
    if (!v) return;
    const f = grabFrame(v);
    setFrame(f);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setStep("review");
    if (!isVisionConfigured()) { setErr("Vision service isn't configured."); return; }
    try {
      const e = await identifyCableFromImage(f);
      setEst(e);
      setType(e.type || "cable");
      setLen(String(Math.round(e.lengthFeet)));
      setGauge(e.gauge || "");
      setConnectors(e.connectors || "");
    } catch (e) {
      setErr(`Couldn't estimate: ${String((e as Error)?.message || e)}`);
      setType("cable");
    }
  };

  const save = async () => {
    setStep("saving");
    try {
      const lengthFt = Number(len) || 0;
      const name = `${cap(type || "Cable")}${lengthFt ? ` ${lengthFt}ft` : ""}`;
      const sizeSpecs = [lengthFt ? `${lengthFt} ft` : "", gauge, connectors].filter(Boolean).join(" · ");
      const photo = frame ? await persistInventoryImage(frame, "item") : null;
      const code = await mintShortCode();
      const { data: created, error } = await supabase.from("items").insert({
        name, category: "Cables", quantity: 1, quantity_unit: "piece", qr_code: code,
        ...(sizeSpecs ? { size_specs: sizeSpecs } : {}), ...(photo ? { photo_path: photo } : {}),
      }).select("id").single();
      if (error) throw error;
      noteSessionItem(created!.id as string);
      // Print the cord-end tag (desktop station). On the iPad the connector isn't reachable — the
      // item is filed and the desktop can print it (auto-print bridge or the item list).
      if (isLabelOutputSupported()) {
        const media = getLabelMedia();
        const sub = [lengthFt ? `${lengthFt} ft` : "", connectors].filter(Boolean) as string[];
        const label = renderItemLabel({ name, code, sub, media, logo: null }).toDataURL("image/png");
        await printResilient(label, media, name);
      }
      haptic.success();
      toast({ title: "Cord labeled", description: isLabelOutputSupported() ? `${name} — tag printing.` : `${name} — print its tag from the desktop.`, variant: "success" });
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setStep("review");
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b p-3">
        <div className="flex items-center gap-2"><Cable className="h-5 w-5 text-primary" /><span className="font-display font-semibold">Label a cord</span></div>
        <button onClick={() => onOpenChange(false)} className="rounded p-1.5 hover:bg-muted" aria-label="Close"><X className="h-5 w-5" /></button>
      </div>

      {step === "camera" && (
        <>
          <div className="relative flex-1 overflow-hidden bg-black">
            <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
            <p className="absolute inset-x-0 bottom-20 text-center text-sm text-white/90 drop-shadow">Hold the wrapped cord in frame</p>
          </div>
          <div className="border-t p-4">
            {err ? <p className="mb-2 text-center text-sm text-destructive">{err}</p> : null}
            <Button className="w-full" onClick={capture}><Camera className="mr-2 h-4 w-4" /> Capture</Button>
          </div>
        </>
      )}

      {(step === "review" || step === "saving") && (
        <div className="flex-1 overflow-y-auto p-4">
          {frame && <img src={frame} alt="" className="mb-3 max-h-48 w-full rounded-lg object-contain bg-muted" />}
          {!est && !err && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Estimating length…</div>}
          {err && <p className="mb-2 text-sm text-destructive">{err}</p>}
          {est && (
            <p className="mb-3 text-xs text-muted-foreground">
              AI estimate{est.lengthMin != null && est.lengthMax != null ? ` — roughly ${Math.round(est.lengthMin)}–${Math.round(est.lengthMax)} ft` : ""} · adjust anything below.
            </p>
          )}
          <div className="space-y-3">
            <div><label className="text-xs text-muted-foreground">Type</label><Input value={type} onChange={(e) => setType(e.target.value)} placeholder="extension cord" /></div>
            <div><label className="text-xs text-muted-foreground">Length (feet)</label><Input inputMode="decimal" value={len} onChange={(e) => setLen(e.target.value)} placeholder="25" /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="text-xs text-muted-foreground">Gauge</label><Input value={gauge} onChange={(e) => setGauge(e.target.value)} placeholder="14 AWG" /></div>
              <div><label className="text-xs text-muted-foreground">Connectors</label><Input value={connectors} onChange={(e) => setConnectors(e.target.value)} placeholder="NEMA 5-15" /></div>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button className="flex-1" onClick={save} disabled={step === "saving" || !type.trim()}>
              {step === "saving" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : isLabelOutputSupported() ? <Printer className="mr-2 h-4 w-4" /> : <Check className="mr-2 h-4 w-4" />}
              {isLabelOutputSupported() ? "Save & print tag" : "Save cord"}
            </Button>
            <Button variant="secondary" onClick={() => { setStep("camera"); onOpenChange(false); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
