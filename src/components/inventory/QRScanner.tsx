import { useState, useRef, useEffect, useCallback } from "react";
import { X, Camera, Upload, Package, MapPin, ScanLine, Loader2 } from "lucide-react";
import jsQR from "jsqr";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/adaptive-dialog";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { setConnectorHost } from "@/components/inventory/PrinterService";
import { BinFillDialog } from "./BinFillDialog";

interface QRScannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set as the dialog opens (e.g. from a USB barcode scanner), resolve this code directly
   *  instead of starting the camera. */
  initialCode?: string;
}

interface ScanResult {
  code: string;
  kind: "bin" | "space" | "item" | "unknown";
  title: string;
  path: string;
  locationId?: string;
  items: { name: string; quantity: number }[];
}

/** Resolve a scanned code against locations (bins/spaces) and items. */
async function resolveCode(code: string): Promise<ScanResult> {
  const { data: loc } = await supabase
    .from("locations")
    .select("id, name, is_slot, type, parent_location_id")
    .eq("qr_code", code)
    .maybeSingle();

  if (loc) {
    // Build the human path: Place · Space (for a bin) or Place (for a space).
    let path = "";
    if (loc.parent_location_id) {
      const { data: parent } = await supabase
        .from("locations")
        .select("name, parent_location_id")
        .eq("id", loc.parent_location_id)
        .maybeSingle();
      if (parent) {
        path = parent.name;
        if (parent.parent_location_id) {
          const { data: gp } = await supabase
            .from("locations").select("name").eq("id", parent.parent_location_id).maybeSingle();
          if (gp) path = `${gp.name} · ${parent.name}`;
        }
      }
    }

    const { data: links } = await supabase
      .from("item_locations")
      .select("item_id, quantity")
      .eq("location_id", loc.id)
      .is("date_removed", null);
    const ids = (links ?? []).map((l) => l.item_id);
    const { data: its } = ids.length
      ? await supabase.from("items").select("id, name").in("id", ids)
      : { data: [] as { id: string; name: string }[] };
    const qtyById = new Map((links ?? []).map((l) => [l.item_id, l.quantity ?? 1]));
    const items = (its ?? []).map((i) => ({ name: i.name, quantity: qtyById.get(i.id) ?? 1 }));

    return {
      code,
      // A bin is either a legacy slot OR a standalone bin created by the sort flow (type "bin").
      kind: loc.is_slot || loc.type === "bin" ? "bin" : "space",
      title: loc.name,
      path,
      locationId: loc.id,
      items,
    };
  }

  const { data: item } = await supabase
    .from("items")
    .select("id, name, quantity")
    .eq("qr_code", code)
    .maybeSingle();
  if (item) {
    // Where does this item live?
    const { data: link } = await supabase
      .from("item_locations")
      .select("location_id")
      .eq("item_id", item.id)
      .is("date_removed", null)
      .maybeSingle();
    let path = "No bin assigned";
    if (link) {
      const { data: bin } = await supabase
        .from("locations").select("name").eq("id", link.location_id).maybeSingle();
      if (bin) path = bin.name;
    }
    return { code, kind: "item", title: item.name, path, items: [] };
  }

  return { code, kind: "unknown", title: "Not in your inventory", path: "", items: [] };
}

export function QRScanner({ open, onOpenChange, initialCode }: QRScannerProps) {
  const [scanning, setScanning] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [fillOpen, setFillOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rafRef = useRef<number>(0);
  const { toast } = useToast();

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const onDecoded = useCallback(async (code: string) => {
    setScanning(false);
    stopCamera();
    // A printer-connect QR (shown on the Mac in Settings → Connect your Mac) — link to that
    // connector instead of doing an inventory lookup. Format: "tvconn:<host>[:<port>]".
    const conn = code.trim().match(/^tvconn:\/?\/?(.+)$/i);
    if (conn) {
      const host = conn[1].trim();
      setConnectorHost(host);
      const url = /:\d+$/.test(host) ? host : `${host}:17777`;
      const ok = await fetch(`http://${url}/health`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.ok).catch(() => false);
      toast(ok
        ? { title: "Printer connected", description: `Linked to ${host}. Labels print on that computer.`, variant: "success" }
        : { title: "Saved — not reachable yet", description: "Same Wi-Fi + connector running? (On the iPad, printing routes through the Mac.)", variant: "destructive" });
      onOpenChange(false);
      return;
    }
    setResolving(true);
    try {
      setResult(await resolveCode(code));
    } catch (e) {
      toast({ title: "Lookup failed", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setResolving(false);
    }
  }, [stopCamera, toast, onOpenChange]);

  // A code handed in from a USB barcode scanner: resolve it straight away, no camera.
  useEffect(() => {
    if (open && initialCode) void onDecoded(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialCode]);

  // Live camera decode loop.
  useEffect(() => {
    if (!open || !scanning) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const tick = () => {
          if (cancelled) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const qr = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (qr?.data) { void onDecoded(qr.data); return; }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        toast({ title: "Camera unavailable", description: "Check camera permission, or scan from a photo instead.", variant: "destructive" });
        setScanning(false);
      }
    })();
    return () => { cancelled = true; stopCamera(); };
  }, [open, scanning, onDecoded, stopCamera, toast]);

  const scanFile = async (file?: File) => {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const qr = jsQR(img.data, img.width, img.height);
      if (qr?.data) void onDecoded(qr.data);
      else toast({ title: "No QR code found", description: "Try a closer, sharper photo of the label.", variant: "destructive" });
    } catch (e) {
      toast({ title: "Couldn't read the photo", description: String((e as Error)?.message || e), variant: "destructive" });
    }
  };

  const close = (v: boolean) => {
    if (!v) { setScanning(false); stopCamera(); setResult(null); }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <ScanLine className="h-5 w-5" /> Scan a label
          </DialogTitle>
        </DialogHeader>

        {!scanning && !result && !resolving && (
          <div className="text-center space-y-4 py-2">
            <p className="text-muted-foreground text-sm">
              Point at a bin or tool label to jump straight to what's stored there.
            </p>
            <div className="flex gap-2 justify-center">
              <Button onClick={() => setScanning(true)}>
                <Camera className="h-4 w-4 mr-2" /> Start camera
              </Button>
              <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" /> From photo
              </Button>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => scanFile(e.target.files?.[0])} />
          </div>
        )}

        {scanning && (
          <div className="space-y-3">
            <div className="relative rounded-lg overflow-hidden border">
              <video ref={videoRef} className="w-full" autoPlay playsInline muted />
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-44 h-44 border-2 border-primary rounded" />
              </div>
            </div>
            <canvas ref={canvasRef} className="hidden" />
            <div className="text-center">
              <Button variant="outline" onClick={() => { setScanning(false); stopCamera(); }}>
                <X className="h-4 w-4 mr-2" /> Stop
              </Button>
            </div>
          </div>
        )}

        {resolving && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Looking it up…
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="rounded-md border p-3">
              <div className="flex items-center gap-2">
                {result.kind === "item"
                  ? <Package className="h-4 w-4 text-primary shrink-0" aria-hidden />
                  : <MapPin className="h-4 w-4 text-primary shrink-0" aria-hidden />}
                <div className="min-w-0">
                  <div className="font-semibold truncate">{result.title}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {result.kind === "item" ? `Stored in: ${result.path}` : result.path || "Top-level"}
                  </div>
                </div>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground mt-2 truncate">{result.code}</div>
            </div>

            {(result.kind === "bin" || result.kind === "space") && (
              <div className="rounded-md border p-3">
                <div className="font-display text-sm font-semibold mb-2">
                  Contents ({result.items.length})
                </div>
                {result.items.length > 0 ? (
                  <ul className="text-sm text-muted-foreground space-y-1">
                    {result.items.map((it, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span className="truncate">{it.name}</span>
                        {it.quantity > 1 && <span className="font-mono shrink-0">×{it.quantity}</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Empty.</p>
                )}
              </div>
            )}

            {result.kind === "unknown" && (
              <p className="text-sm text-muted-foreground">
                This code isn't a bin, space, or tool in your inventory.
              </p>
            )}

            <div className="flex flex-wrap gap-2 justify-center">
              {result.kind === "bin" && result.locationId && (
                <Button onClick={() => setFillOpen(true)}>
                  <Camera className="h-4 w-4 mr-2" /> Fill bin with camera
                </Button>
              )}
              <Button variant="outline" onClick={() => { setResult(null); setScanning(true); }}>
                <ScanLine className="h-4 w-4 mr-2" /> Scan another
              </Button>
              <Button variant="ghost" onClick={() => close(false)}>Close</Button>
            </div>
          </div>
        )}

        <BinFillDialog
          open={fillOpen}
          onOpenChange={setFillOpen}
          bin={result?.locationId ? { id: result.locationId, name: result.title } : null}
          onSaved={() => { if (result) void resolveCode(result.code).then(setResult); }}
        />
      </DialogContent>
    </Dialog>
  );
}
