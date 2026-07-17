// Overlay Scan — a top-down "AI scanner" for the iPad on a swivel mount, camera facing down at the
// desk. The live camera shows boxes over whatever the model sees, with a small "thinking" status.
// High-confidence items file themselves automatically (green box, with an undo window); only when the
// model is UNSURE does a multiple-choice card appear so you can confirm or fix it with a tap. Voice
// and printing are intentionally absent here — this mode is cloud-only (camera + AI + Supabase), so it
// works on the live-loaded iPad where the local print/voice connector isn't reachable.

import { useEffect, useRef, useState } from "react";
import { Loader2, X, Check, Undo2, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { haptic } from "@/lib/haptics";
import { detectSpotsFromImage, identifyItemFromImage, isVisionConfigured, type SpotSuggestion } from "@/lib/vision";
import { persistInventoryImage } from "@/lib/imageStorage";
import { mintShortCode } from "@/lib/shortcode";
import { cropBox } from "@/lib/imageCrop";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bin: { id: string; name: string } | null;
  onSaved?: () => void;
}

// Confidence at/above which we auto-file without asking; below it we surface a confirm card.
const AUTO_FILE = 0.75;
const SCAN_MS = 2200; // gap between scans — long enough for a vision round-trip + for you to place items
const CATEGORY_CHIPS = ["Power Tool Accessories", "Hand Tools", "Fasteners", "Plumbing", "Electrical", "PPE", "Marking Tools", "Other"];

function grabFrame(video: HTMLVideoElement, maxW = 960, quality = 0.72): string {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const scale = Math.min(1, maxW / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
  c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

const keyOf = (s: SpotSuggestion) => s.label.trim().toLowerCase();

type Pending = { spot: SpotSuggestion; crop?: string; name: string; category: string };

export function ScanMode({ open, onOpenChange, bin, onSaved }: Props) {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const aliveRef = useRef(false);
  const busyRef = useRef(false);
  const filedRef = useRef<Set<string>>(new Set()); // labels already filed/handled — dedup across scans
  const pendingRef = useRef<Pending | null>(null);  // mirror of `pending` for the scan closure

  const [status, setStatus] = useState<"starting" | "scanning" | "error">("starting");
  const [thinking, setThinking] = useState("Starting the camera…");
  const [spots, setSpots] = useState<SpotSuggestion[]>([]);
  const [count, setCount] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lastUndo, setLastUndo] = useState<{ id: string; name: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const setPend = (p: Pending | null) => { pendingRef.current = p; setPending(p); };

  // Create the item + file it into the bin, with its cropped photo stored in the bucket.
  const fileItem = async (name: string, category: string, crop: string | undefined, brand = "", model = "") => {
    const photo = crop ? await persistInventoryImage(crop, "item") : null;
    const code = await mintShortCode();
    const { data: created, error } = await supabase.from("items").insert({
      name, category: category || "Other", quantity: 1, quantity_unit: "piece",
      qr_code: code, photo_path: photo,
      ...(brand ? { brand } : {}), ...(model ? { model } : {}),
    }).select("id").single();
    if (error) throw error;
    const { error: linkErr } = await supabase
      .from("item_locations").insert({ item_id: created!.id, location_id: bin!.id, quantity: 1 });
    if (linkErr) throw linkErr;
    setCount((c) => c + 1);
    setLastUndo({ id: created!.id as string, name });
    haptic.success();
  };

  const undoLast = async () => {
    if (!lastUndo) return;
    await supabase.from("item_locations").delete().eq("item_id", lastUndo.id);
    await supabase.from("items").delete().eq("id", lastUndo.id);
    setCount((c) => Math.max(0, c - 1));
    toast({ title: `Removed ${lastUndo.name}` });
    setLastUndo(null);
  };

  useEffect(() => {
    if (!open || !bin) return;
    if (!isVisionConfigured()) { setStatus("error"); setErrorMsg("Vision service isn't configured."); return; }
    aliveRef.current = true;
    filedRef.current = new Set();
    setPend(null); setSpots([]); setCount(0); setLastUndo(null); setErrorMsg("");
    setStatus("starting"); setThinking("Starting the camera…");
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scanOnce = async () => {
      const video = videoRef.current;
      if (!aliveRef.current || !video || busyRef.current || pendingRef.current) return;
      busyRef.current = true;
      try {
        const frame = grabFrame(video);
        setThinking("Looking…");
        const found = await detectSpotsFromImage(frame);
        if (!aliveRef.current) return;
        setSpots(found);
        const fresh = found.filter((s) => !filedRef.current.has(keyOf(s)));
        setThinking(found.length ? `${found.length} in view · ${fresh.length} new` : "Nothing detected — place items in view");
        for (const s of fresh) {
          if (pendingRef.current) break; // one confirm card at a time
          if (s.confidence >= AUTO_FILE) {
            filedRef.current.add(keyOf(s)); // claim it before the async work so the next scan won't double-file
            const crop = await cropBox(frame, s.box);
            const det = crop ? await identifyItemFromImage(crop).catch(() => null) : null;
            try {
              await fileItem(det?.name || s.label, det?.category || "Other", crop, det?.brand || "", det?.model || "");
            } catch (e) {
              filedRef.current.delete(keyOf(s)); // filing failed — let a later scan retry it
              toast({ title: "Couldn't file an item", description: String((e as Error)?.message || e), variant: "destructive" });
            }
          } else {
            // Unsure → surface a confirm card and stop auto-processing until the user answers.
            const crop = await cropBox(frame, s.box);
            setPend({ spot: s, crop, name: s.label, category: "Other" });
            break;
          }
        }
      } catch (e) {
        if (aliveRef.current) setThinking(`Scan hiccup: ${String((e as Error)?.message || e).slice(0, 60)}`);
      } finally {
        busyRef.current = false;
        if (aliveRef.current) timer = setTimeout(scanOnce, SCAN_MS);
      }
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false,
        });
        if (!aliveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
        setStatus("scanning");
        setThinking("Place items under the camera…");
        timer = setTimeout(scanOnce, 600);
      } catch (e) {
        setStatus("error");
        setErrorMsg(`Camera unavailable: ${String((e as Error)?.message || e)}`);
      }
    })();

    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open, bin]); // eslint-disable-line react-hooks/exhaustive-deps

  const confirmPending = async (name: string, category: string) => {
    const p = pendingRef.current;
    if (!p) return;
    filedRef.current.add(keyOf(p.spot));
    try {
      await fileItem(name.trim() || p.spot.label, category, p.crop);
    } catch (e) {
      toast({ title: "Couldn't file", description: String((e as Error)?.message || e), variant: "destructive" });
    }
    setPend(null);
  };

  const skipPending = () => {
    const p = pendingRef.current;
    if (p) filedRef.current.add(keyOf(p.spot)); // don't re-prompt for the same thing
    setPend(null);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col">
      {/* live camera */}
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />

        {/* overlay boxes (normalized coords → % of the frame) */}
        {spots.map((s, i) => {
          const filed = filedRef.current.has(keyOf(s));
          const color = filed ? "#22c55e" : s.confidence >= AUTO_FILE ? "#38bdf8" : "#f59e0b";
          return (
            <div key={`${keyOf(s)}-${i}`} className="absolute rounded-md border-2 transition-all"
              style={{ left: `${s.box.x * 100}%`, top: `${s.box.y * 100}%`, width: `${s.box.w * 100}%`, height: `${s.box.h * 100}%`, borderColor: color, boxShadow: `0 0 0 1px rgba(0,0,0,.4)` }}>
              <span className="absolute -top-6 left-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium"
                style={{ background: color, color: "#0b0f14" }}>
                {filed && <Check className="h-3 w-3" />}{s.label} · {Math.round(s.confidence * 100)}%
              </span>
            </div>
          );
        })}

        {/* top status bar */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent p-3">
          <div className="flex items-center gap-2 text-sm">
            {status === "scanning" ? <ScanLine className="h-4 w-4 text-sky-400" /> : <Loader2 className="h-4 w-4 animate-spin" />}
            <span className="font-medium">{thinking}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-white/15 px-2.5 py-1 text-xs">Filed: {count}</span>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-white hover:bg-white/15" onClick={() => onOpenChange(false)}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* undo pill */}
        {lastUndo && !pending && (
          <button onClick={undoLast} className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-sm backdrop-blur">
            <Undo2 className="h-4 w-4" /> Undo “{lastUndo.name}”
          </button>
        )}
      </div>

      {/* error */}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90 p-6 text-center">
          <p className="text-lg font-semibold">Can’t scan</p>
          <p className="max-w-sm text-sm text-white/70">{errorMsg}</p>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      )}

      {/* multiple-choice confirm card — only when the model is unsure */}
      {pending && (
        <div className="border-t border-white/10 bg-neutral-900 p-4">
          <div className="mx-auto flex max-w-md items-start gap-3">
            {pending.crop && <img src={pending.crop} alt="" className="h-16 w-16 flex-none rounded-md object-cover" />}
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-xs text-amber-400">Not sure about this one — is it…?</p>
              <input
                defaultValue={pending.name}
                onChange={(e) => { if (pendingRef.current) pendingRef.current.name = e.target.value; }}
                className="mb-2 w-full rounded-md bg-white/10 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-sky-400"
              />
              <div className="mb-3 flex flex-wrap gap-1.5">
                {CATEGORY_CHIPS.map((c) => (
                  <button key={c} onClick={() => { if (pendingRef.current) pendingRef.current.category = c; setPend({ ...pendingRef.current! }); }}
                    className={`rounded-full px-2.5 py-1 text-xs ${pending.category === c ? "bg-sky-500 text-black" : "bg-white/10 text-white/80"}`}>
                    {c}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="flex-1" onClick={() => confirmPending(pendingRef.current!.name, pendingRef.current!.category)}>
                  <Check className="mr-1 h-4 w-4" /> File it
                </Button>
                <Button size="sm" variant="secondary" onClick={skipPending}>Skip</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
