// Rapid Mode — a hands-free labeling station. You open a bin, the webcam turns on, and you present
// tools to the camera one at a time. When an item holds still the AI identifies it, the assistant
// SPEAKS what it sees, and you answer by voice ("yes" / "skip" / "done"). On "yes" it mints a code,
// stores the item in this bin with its photo, and prints a barcode label — no typing, ever. Closing
// the bin prints the bin's categorized label. Works on the desktop station (Logitech webcam) and in
// the iOS app (device camera), transcribing speech on the connector's local whisper.cpp.

import { useEffect, useRef, useState } from "react";
import { Mic, Loader2, X, Sparkles, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { haptic } from "@/lib/haptics";
import { identifyItemFromImage, isVisionConfigured } from "@/lib/vision";
import { mintShortCode } from "@/lib/shortcode";
import { renderItemLabel } from "@/lib/itemLabel";
import { renderBinLabel } from "@/lib/binLabel";
import { printImageViaConnector, getLabelMedia } from "@/components/inventory/PrinterService";
import { speak, stopSpeaking } from "@/lib/speech";
import { listen } from "@/lib/whisperStt";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bin: { id: string; name: string } | null;
  onSaved?: () => void;
}

type Phase = "starting" | "scanning" | "identifying" | "confirming" | "saving" | "finishing" | "error";

const YES = /\b(yes|yeah|yep|yup|label|add|do it|okay|ok|sure|correct|print|go)\b/;
const SKIP = /\b(skip|no|nope|next|pass|wrong|another)\b/;
const DONE = /\b(done|finish|finished|close|complete|that'?s it|stop|end|exit|quit)\b/;

/** Draw the current video frame to a JPEG data URL, scaled so the longer side ≈ maxW. */
function grabFrame(video: HTMLVideoElement, maxW = 960, quality = 0.72): string {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const scale = Math.min(1, maxW / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
  c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

export function RapidMode({ open, onOpenChange, bin, onSaved }: Props) {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const aliveRef = useRef(false);
  const finishRef = useRef(false);
  const prevGrayRef = useRef<Uint8ClampedArray | null>(null);

  const [phase, setPhase] = useState<Phase>("starting");
  const [caption, setCaption] = useState("");   // what the assistant just said
  const [heard, setHeard] = useState("");        // last thing it understood
  const [count, setCount] = useState(0);         // items labeled this session
  const [errorMsg, setErrorMsg] = useState("");

  const say = async (text: string) => { setCaption(text); await speak(text); };

  useEffect(() => {
    if (!open || !bin) return;
    aliveRef.current = true;
    finishRef.current = false;
    setPhase("starting"); setCount(0); setHeard(""); setErrorMsg("");
    const labeledCategories: string[] = [];

    // --- camera + mic ---
    const startMedia = async (): Promise<MediaStream> => {
      let stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      // On a desktop, prefer an external USB webcam (Logitech/Brio/C920…) over the built-in FaceTime cam.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter((d) => d.kind === "videoinput");
        const ext = cams.find((d) => /logitech|brio|c9\d\d|webcam|usb|razer|elgato/i.test(d.label));
        const currentId = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (ext && ext.deviceId && ext.deviceId !== currentId) {
          stream.getTracks().forEach((t) => t.stop());
          stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: ext.deviceId }, width: { ideal: 1280 } },
            audio: { echoCancellation: true, noiseSuppression: true },
          });
        }
      } catch { /* enumerate/switch failed — keep the default camera */ }
      return stream;
    };

    // --- video-motion stability: mean abs difference of a downscaled grayscale frame ---
    const STILL_CANVAS = document.createElement("canvas");
    STILL_CANVAS.width = 96; STILL_CANVAS.height = 72;
    const stillCtx = STILL_CANVAS.getContext("2d", { willReadFrequently: true })!;
    const frameDiff = (video: HTMLVideoElement): number => {
      stillCtx.drawImage(video, 0, 0, 96, 72);
      const cur = stillCtx.getImageData(0, 0, 96, 72).data;
      const prev = prevGrayRef.current;
      const gray = new Uint8ClampedArray(96 * 72);
      let diff = 0;
      for (let i = 0, p = 0; i < cur.length; i += 4, p++) {
        gray[p] = (cur[i] * 0.3 + cur[i + 1] * 0.59 + cur[i + 2] * 0.11) | 0;
        if (prev) diff += Math.abs(gray[p] - prev[p]);
      }
      prevGrayRef.current = gray;
      return prev ? diff / gray.length : 999;
    };

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // Watch for a new item to be held steady; between watch windows, briefly listen for "done".
    // Returns a captured frame, or null if the session should finish.
    const waitForItemOrDone = async (video: HTMLVideoElement): Promise<string | null> => {
      const MOVE = 11, STILL = 5, STEADY_NEEDED = 2;
      let moved = false, steady = 0, watched = 0;
      prevGrayRef.current = null; // reset baseline so the first ticks re-learn the scene
      while (aliveRef.current && !finishRef.current) {
        const d = frameDiff(video);
        if (d > MOVE) { moved = true; steady = 0; }
        else if (moved && d < STILL) {
          steady++;
          if (steady >= STEADY_NEEDED) return grabFrame(video);
        }
        watched += 320;
        await sleep(320);
        // Every ~6s of quiet watching, give a voice window to say "done".
        if (watched >= 6000 && !moved) {
          watched = 0;
          const cmd = await listen(new MediaStream(streamRef.current!.getAudioTracks()), 2600);
          if (cmd) setHeard(cmd);
          if (DONE.test(cmd)) return null;
        }
      }
      return null;
    };

    const listenCommand = async (): Promise<string> => {
      const cmd = await listen(new MediaStream(streamRef.current!.getAudioTracks()), 3200);
      setHeard(cmd || "…");
      return cmd;
    };

    const saveAndPrint = async (item: { name: string; category?: string; brand?: string; model?: string }, frame: string) => {
      const code = await mintShortCode();
      const media = getLabelMedia();
      // Store the item in this bin, with the captured photo inline (no storage bucket needed).
      const insert: Record<string, unknown> = {
        name: item.name, category: item.category || "other", quantity: 1,
        quantity_unit: "piece", qr_code: code, photo_path: frame,
      };
      if (item.brand) insert.brand = item.brand;
      if (item.model) insert.model = item.model;
      let { data: created, error } = await supabase.from("items").insert(insert).select("id").single();
      if (error && /photo_path|column/.test(error.message)) {
        delete insert.photo_path;
        ({ data: created, error } = await supabase.from("items").insert(insert).select("id").single());
      }
      if (error) throw error;
      await supabase.from("item_locations").insert({ item_id: created!.id, location_id: bin!.id, quantity: 1 });
      if (item.category) labeledCategories.push(item.category);
      const sub = [item.category, [item.brand, item.model].filter(Boolean).join(" ")].filter(Boolean) as string[];
      const label = renderItemLabel({ name: item.name, code, sub, media }).toDataURL("image/png");
      await printImageViaConnector(label, media);
    };

    const printBinLabel = async () => {
      const media = getLabelMedia();
      const { data: b } = await supabase
        .from("locations")
        .select("qr_code,slot_index,category,parent_location_id")
        .eq("id", bin!.id).maybeSingle();
      if (!b) return;
      // If the bin has no category yet, adopt the most common category of what we just labeled.
      let category = (b as { category?: string }).category || "";
      if (!category && labeledCategories.length) {
        const counts = new Map<string, number>();
        labeledCategories.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
        category = [...counts.entries()].sort((a, b2) => b2[1] - a[1])[0][0];
        category = category.replace(/\b\w/g, (m) => m.toUpperCase());
        await supabase.from("locations").update({ category }).eq("id", bin!.id);
      }
      let location = bin!.name;
      const parentId = (b as { parent_location_id?: string }).parent_location_id;
      if (parentId) {
        const { data: p } = await supabase.from("locations").select("name").eq("id", parentId).maybeSingle();
        if (p?.name) location = p.name;
      }
      const num = (parseInt(bin!.name.replace(/\D/g, ""), 10) || ((b as { slot_index?: number }).slot_index ?? 0) + 1);
      const canvas = renderBinLabel({
        number: num, code: (b as { qr_code?: string }).qr_code || bin!.name, location, category, media,
      });
      await printImageViaConnector(canvas.toDataURL("image/png"), media);
    };

    const finishSession = async () => {
      if (!aliveRef.current) return;
      setPhase("finishing");
      await say(count ? "Printing the bin label. All set." : "No items added. Printing the bin label.");
      try { await printBinLabel(); } catch { /* printer offline — data is saved regardless */ }
      onSaved?.();
      onOpenChange(false);
    };

    // --- main session loop ---
    const run = async () => {
      if (!isVisionConfigured()) {
        setErrorMsg("The vision service isn't connected, so hands-free identify won't work. Use Fill bin with camera instead.");
        setPhase("error");
        return;
      }
      let stream: MediaStream;
      try {
        stream = await startMedia();
      } catch {
        setErrorMsg("Couldn't open the camera and microphone. Allow access, then reopen Rapid Mode.");
        setPhase("error");
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => { /* autoplay guard */ });

      await say(`Rapid mode for ${bin!.name}. Show me an item.`);
      while (aliveRef.current && !finishRef.current) {
        setPhase("scanning");
        const frame = await waitForItemOrDone(video);
        if (!aliveRef.current) return;
        if (finishRef.current || frame === null) break;

        setPhase("identifying");
        let item: { name?: string; category?: string; brand?: string; model?: string };
        try {
          item = await identifyItemFromImage(frame);
        } catch {
          await say("I couldn't reach the vision service. Try again.");
          continue;
        }
        if (!item?.name) { await say("I couldn't tell what that is. Hold it steady and try again."); continue; }

        setPhase("confirming");
        await say(`${item.name}. Say yes to label it, skip to pass, or done to finish.`);
        const cmd = await listenCommand();
        if (DONE.test(cmd)) break;
        if (SKIP.test(cmd)) { await say("Skipped."); continue; }
        if (YES.test(cmd)) {
          setPhase("saving");
          try {
            await saveAndPrint(item, frame);
            haptic.success();
            setCount((c) => c + 1);
            await say(`Labeled ${item.name}.`);
          } catch (e) {
            await say("I couldn't save that one.");
            toast({ title: "Couldn't save item", description: String((e as Error)?.message || e), variant: "destructive" });
          }
          continue;
        }
        await say("I didn't catch that. Show me the next item, or say done.");
      }
      await finishSession();
    };

    run();

    return () => {
      aliveRef.current = false;
      stopSpeaking();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      prevGrayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bin?.id]);

  const finishNow = () => { finishRef.current = true; };

  if (!open) return null;

  const phaseLabel: Record<Phase, string> = {
    starting: "Starting camera…",
    scanning: "Show me an item — hold it steady",
    identifying: "Looking…",
    confirming: "Say yes, skip, or done",
    saving: "Labeling & printing…",
    finishing: "Printing bin label…",
    error: "Rapid Mode unavailable",
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black text-white flex flex-col">
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover opacity-90" />

      {/* top bar */}
      <div className="relative z-10 flex items-center justify-between p-4 bg-gradient-to-b from-black/70 to-transparent">
        <div className="flex items-center gap-2 font-display">
          <Sparkles className="h-5 w-5 text-primary" />
          <span>Rapid Mode · {bin?.name}</span>
          {count > 0 && <span className="ml-2 rounded-full bg-primary/90 px-2 py-0.5 text-xs">{count} labeled</span>}
        </div>
        <Button size="icon" variant="ghost" className="text-white hover:bg-white/20" onClick={finishNow} aria-label="Finish">
          <X className="h-6 w-6" />
        </Button>
      </div>

      {/* center status */}
      <div className="relative z-10 flex-1 flex items-center justify-center pointer-events-none">
        <div className="flex flex-col items-center gap-3 text-center px-6">
          {(phase === "identifying" || phase === "saving" || phase === "finishing" || phase === "starting") && (
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
          )}
          {phase === "scanning" && (
            <div className="h-40 w-40 rounded-2xl border-4 border-primary/70 animate-pulse" />
          )}
          <div className="text-lg font-display drop-shadow">{phaseLabel[phase]}</div>
        </div>
      </div>

      {/* bottom captions */}
      <div className="relative z-10 p-4 pb-8 bg-gradient-to-t from-black/80 to-transparent space-y-2">
        {errorMsg ? (
          <p className="text-sm text-center text-red-200">{errorMsg}</p>
        ) : (
          <>
            {caption && (
              <p className="flex items-center justify-center gap-2 text-base text-center">
                <Volume2 className="h-4 w-4 shrink-0 text-primary" /> {caption}
              </p>
            )}
            {heard && (
              <p className="flex items-center justify-center gap-2 text-sm text-center text-white/70">
                <Mic className="h-3.5 w-3.5 shrink-0" /> “{heard}”
              </p>
            )}
          </>
        )}
        <div className="flex justify-center pt-2">
          <Button variant="secondary" onClick={finishNow}>
            {phase === "error" ? "Close" : "Finish & print bin label"}
          </Button>
        </div>
      </div>
    </div>
  );
}
