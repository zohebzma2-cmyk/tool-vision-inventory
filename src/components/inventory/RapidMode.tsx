// Rapid Mode — a hands-free labeling station. You open a bin, the webcam turns on, and you present
// tools to the camera one at a time. When an item holds still the AI identifies it, the assistant
// SPEAKS what it sees, and you answer by voice ("yes" / "skip" / "done" / "two" / "undo"). On "yes"
// it mints a code, stores the item in this bin with its photo, and prints a barcode label — no
// typing, ever. Closing the bin prints the bin's categorized label. Works on the desktop station
// (Logitech webcam) and in the iOS app (device camera), transcribing on the connector's whisper.cpp.

import { useEffect, useRef, useState } from "react";
import { Mic, Loader2, X, Sparkles, Volume2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { haptic } from "@/lib/haptics";
import { identifyItemFromImage, isVisionConfigured } from "@/lib/vision";
import { mintShortCode } from "@/lib/shortcode";
import { renderItemLabel, loadBrandLogo } from "@/lib/itemLabel";
import { renderBinLabel } from "@/lib/binLabel";
import { getLabelMedia } from "@/components/inventory/PrinterService";
import { printResilient } from "@/lib/printQueue";
import { findItemInBin, mergeQuantity } from "@/lib/itemDedupe";
import { speak, stopSpeaking } from "@/lib/speech";
import { listen } from "@/lib/whisperStt";
import { classifyCommand, DONE } from "@/lib/voiceCommands";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bin: { id: string; name: string } | null;
  onSaved?: () => void;
}

type Phase = "starting" | "scanning" | "captured" | "identifying" | "confirming" | "saving" | "finishing" | "error";

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
  const countRef = useRef(0);            // live count (the effect closure can't see React state updates)

  const [phase, setPhase] = useState<Phase>("starting");
  const [caption, setCaption] = useState("");   // what the assistant just said
  const [heard, setHeard] = useState("");        // last thing it understood
  const [count, setCount] = useState(0);         // items labeled this session (for display)
  const [errorMsg, setErrorMsg] = useState("");

  const say = async (text: string) => { setCaption(text); await speak(text); };
  /** The audio-only stream for the recorder — null if we've been torn down mid-await. */
  const audioStream = (): MediaStream | null => {
    const s = streamRef.current;
    return s && aliveRef.current ? new MediaStream(s.getAudioTracks()) : null;
  };

  useEffect(() => {
    if (!open || !bin) return;
    aliveRef.current = true;
    finishRef.current = false;
    countRef.current = 0;
    setPhase("starting"); setCount(0); setHeard(""); setErrorMsg("");
    const labeledCategories: string[] = [];
    let lastCreated: { id: string; name: string } | null = null;

    // --- camera + mic ---
    const startMedia = async (): Promise<MediaStream> => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      // On a desktop, prefer an external USB webcam (Logitech/Brio/C920…) over the built-in FaceTime.
      // Acquire the new stream FIRST, and only stop the old one once it succeeds — a failed switch
      // must never leave us holding a dead (already-stopped) stream.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter((d) => d.kind === "videoinput");
        // Prefer a known external webcam by name; else ANY camera that isn't the built-in FaceTime /
        // Continuity (iPhone) / Desk View — that's the plugged-in USB cam (e.g. a Logitech that macOS
        // exposes only as "UVC Camera VendorID_1133").
        const ext = cams.find((d) => /logitech|brio|c9\d\d|webcam|uvc|razer|elgato|streamcam|hd pro|vendorid_1133/i.test(d.label))
          || cams.find((d) => d.label && !/facetime|built-?in|iphone|continuity|desk\s*view/i.test(d.label));
        const currentId = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (ext && ext.deviceId && ext.deviceId !== currentId) {
          const better = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: ext.deviceId }, width: { ideal: 1280 } },
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          stream.getTracks().forEach((t) => t.stop()); // safe now: `better` is live
          return better;
        }
      } catch { /* switch failed — the original stream is still live, keep it */ }
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
      return prev ? diff / gray.length : 0; // no baseline yet → report "no motion", don't false-trigger
    };

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // Watch for a NEW item held steady. After a capture we require the scene to CLEAR (a real motion
    // spike — the item being taken away) before arming again, so the same item isn't re-scanned.
    // `prevGray` persists across calls (never nulled) so motion is measured against the real scene.
    const MOVE = 12, STILL = 5, STEADY_NEEDED = 2;
    const waitForItemOrDone = async (video: HTMLVideoElement, requireClearFirst: boolean): Promise<string | null> => {
      let moved = false, steady = 0, watched = 0, cleared = !requireClearFirst;
      while (aliveRef.current && !finishRef.current) {
        const d = frameDiff(video);
        if (!cleared) {
          if (d > MOVE) cleared = true;        // item removed / scene changed — now we can arm
        } else if (d > MOVE) { moved = true; steady = 0; }
        else if (moved && d < STILL) {
          steady++;
          if (steady >= STEADY_NEEDED) return grabFrame(video);
        }
        watched += 320;
        await sleep(320);
        if (watched >= 6000 && !moved) {       // periodic voice window to say "done"
          watched = 0;
          const s = audioStream();
          if (s) { const cmd = await listen(s, 2600); if (cmd) setHeard(cmd); if (DONE.test(cmd)) return null; }
        }
      }
      return null;
    };

    const listenCommand = async (ms = 3200): Promise<string> => {
      const s = audioStream();
      if (!s) return "";
      const cmd = await listen(s, ms);
      setHeard(cmd || "…");
      return cmd;
    };

    // Print one label per physical unit — if it's ×2, both copies come out.
    const printCopies = async (dataUrl: string, media: string, name: string, copies: number) => {
      for (let i = 0; i < Math.max(1, copies); i++) await printResilient(dataUrl, media, copies > 1 ? `${name} (${i + 1}/${copies})` : name);
    };

    const saveAndPrint = async (
      item: { name: string; category?: string; brand?: string; model?: string; text?: string }, frame: string, qty: number,
      logoP: Promise<HTMLImageElement | null>,
    ): Promise<{ merged: boolean; total?: number; noLabel?: boolean }> => {
      // Already in this bin? Bump its quantity instead of creating a duplicate row — but still print a
      // label for each newly-added physical unit so every one on the shelf is labeled.
      const dup = await findItemInBin(bin!.id, item.name);
      if (dup) {
        const total = await mergeQuantity(dup, qty);
        lastCreated = null; // a merge isn't a fresh row to undo
        if (dup.code) {
          const media = getLabelMedia();
          const label = renderItemLabel({ name: dup.name, code: dup.code, sub: [], media, logo: await logoP }).toDataURL("image/png");
          await printCopies(label, media, dup.name, qty);
        }
        return { merged: true, total };
      }
      // If the package already carries a real barcode (UPC/EAN in the OCR), store the item with its
      // SKU and DON'T print a Tool Vision label — that's the owner's rule for SKU'd parts.
      const upc = (item.text || "").match(/\b(\d{12,14})\b/)?.[1];
      const code = await mintShortCode();
      const media = getLabelMedia();
      const insert: Record<string, unknown> = {
        name: item.name, category: item.category || "other", quantity: qty,
        quantity_unit: "piece", qr_code: code, photo_path: frame,
      };
      if (upc) insert.notes = `UPC ${upc}`;
      if (item.brand) insert.brand = item.brand;
      if (item.model) insert.model = item.model;
      let { data: created, error } = await supabase.from("items").insert(insert).select("id").single();
      if (error && /photo_path|column/.test(error.message)) {
        delete insert.photo_path;
        ({ data: created, error } = await supabase.from("items").insert(insert).select("id").single());
      }
      if (error) throw error;
      // Filing the item into the bin is the whole point — a failure here must surface, not be swallowed.
      const { error: linkErr } = await supabase
        .from("item_locations").insert({ item_id: created!.id, location_id: bin!.id, quantity: qty });
      if (linkErr) throw linkErr;
      lastCreated = { id: created!.id, name: item.name };
      if (item.category) labeledCategories.push(item.category);
      if (upc) return { merged: false, noLabel: true }; // SKU'd part — stored with its UPC, no TV label
      const sub = [item.category, [item.brand, item.model].filter(Boolean).join(" "), qty > 1 ? `×${qty}` : ""]
        .filter(Boolean) as string[];
      const label = renderItemLabel({ name: item.name, code, sub, media, logo: await logoP }).toDataURL("image/png");
      await printCopies(label, media, item.name, qty); // ×N → one label per unit
      return { merged: false };
    };

    const undoLast = async (): Promise<string> => {
      if (!lastCreated) return "Nothing to undo.";
      const name = lastCreated.name;
      await supabase.from("item_locations").delete().eq("item_id", lastCreated.id);
      await supabase.from("items").delete().eq("id", lastCreated.id);
      lastCreated = null;
      countRef.current = Math.max(0, countRef.current - 1);
      setCount(countRef.current);
      return `Removed ${name}.`;
    };

    const printBinLabel = async () => {
      const media = getLabelMedia();
      const { data: b } = await supabase
        .from("locations").select("qr_code,slot_index,category,parent_location_id").eq("id", bin!.id).maybeSingle();
      if (!b) return;
      let category = (b as { category?: string }).category || "";
      if (!category && labeledCategories.length) {
        const counts = new Map<string, number>();
        labeledCategories.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
        category = [...counts.entries()].sort((a, b2) => b2[1] - a[1])[0][0].replace(/\b\w/g, (m) => m.toUpperCase());
        await supabase.from("locations").update({ category }).eq("id", bin!.id);
      }
      let location = bin!.name;
      const parentId = (b as { parent_location_id?: string }).parent_location_id;
      if (parentId) {
        const { data: p } = await supabase.from("locations").select("name").eq("id", parentId).maybeSingle();
        if (p?.name) location = p.name;
      }
      const num = parseInt(bin!.name.replace(/\D/g, ""), 10) || ((b as { slot_index?: number }).slot_index ?? 0) + 1;
      const canvas = renderBinLabel({
        number: num, code: (b as { qr_code?: string }).qr_code || bin!.name, location, category, media,
      });
      await printResilient(canvas.toDataURL("image/png"), media, `${bin!.name} label`);
    };

    const finishSession = async () => {
      if (!aliveRef.current) return;
      setPhase("finishing");
      await say(countRef.current ? "Printing the bin label. All set." : "No items added. Printing the bin label.");
      try { await printBinLabel(); } catch { /* queued/retried by printResilient regardless */ }
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
      if (!aliveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => { /* autoplay guard */ });

      await say(`Rapid mode for ${bin!.name}. Show me an item.`);
      let firstScan = true;
      while (aliveRef.current && !finishRef.current) {
        setPhase("scanning");
        const frame = await waitForItemOrDone(video, !firstScan); // after the 1st, require the scene to clear
        firstScan = false;
        if (!aliveRef.current) return;
        if (finishRef.current || frame === null) break;

        setPhase("captured");
        haptic.light();
        await sleep(250); // brief "captured" flash

        setPhase("identifying");
        let item: { name?: string; category?: string; brand?: string; model?: string; text?: string };
        try {
          item = await identifyItemFromImage(frame);
        } catch {
          await say("I couldn't reach the vision service. Try again.");
          continue;
        }
        if (!item?.name) { await say("I couldn't tell what that is. Hold it steady and try again."); continue; }

        // Kick off the brand-logo fetch NOW, in parallel with the speak/listen conversation, so it's
        // already loaded and ready to composite by the time we print.
        const logoP = loadBrandLogo(item.brand);

        setPhase("confirming");
        // Confirm the captured item by voice. "repeat"/unclear re-prompts the SAME item (no re-scan);
        // "done"/"skip"/"undo" exit; "yes"/"it's a X" commit. Bounded so a silent mic can't spin forever.
        let decision: "yes" | "skip" | "done" | "none" = "none";
        let qty = 1;
        for (let tries = 0; tries < 3 && decision === "none" && aliveRef.current; tries++) {
          await say(tries === 0
            ? `${item.name}. Say yes to label it, skip to pass, or done to finish.`
            : `${item.name}. Yes, skip, or done?`);
          const cmd = await listenCommand();
          if (!aliveRef.current) return;
          const parsed = classifyCommand(cmd);
          if (parsed.kind === "done") { finishRef.current = true; decision = "done"; break; }
          if (parsed.kind === "undo") { await say(await undoLast()); decision = "skip"; break; }
          if (parsed.kind === "yes") {
            if (parsed.correctedName) item = { ...item, name: parsed.correctedName };
            qty = parsed.qty; decision = "yes";
          } else if (parsed.kind === "skip") { decision = "skip"; }
          // else: unclear → loop and re-prompt the same item
        }
        if (finishRef.current) break;
        if (decision !== "yes") { if (decision === "skip") await say("Skipped."); continue; }

        setPhase("saving");
        try {
          const r = await saveAndPrint(item, frame, qty, logoP);
          haptic.success();
          if (r.merged) {
            await say(`You already have ${item.name} here — now ${r.total}.`);
          } else if (r.noLabel) {
            countRef.current += 1; setCount(countRef.current);
            await say(`${item.name} has a barcode — stored without a new label.`);
          } else {
            countRef.current += 1; setCount(countRef.current);
            await say(`Labeled ${item.name}${qty > 1 ? `, quantity ${qty}` : ""}.`);
          }
        } catch (e) {
          await say("I couldn't save that one.");
          toast({ title: "Couldn't save item", description: String((e as Error)?.message || e), variant: "destructive" });
        }
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
    captured: "Got it",
    identifying: "Looking…",
    confirming: "Say yes, skip, or done",
    saving: "Labeling & printing…",
    finishing: "Printing bin label…",
    error: "Rapid Mode unavailable",
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black text-white flex flex-col">
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover opacity-90" />

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

      <div className="relative z-10 flex-1 flex items-center justify-center pointer-events-none">
        <div className="flex flex-col items-center gap-3 text-center px-6">
          {(phase === "identifying" || phase === "saving" || phase === "finishing" || phase === "starting") && (
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
          )}
          {phase === "captured" && <Check className="h-14 w-14 text-primary" />}
          {phase === "scanning" && <div className="h-40 w-40 rounded-2xl border-4 border-primary/70 animate-pulse" />}
          <div className="text-lg font-display drop-shadow">{phaseLabel[phase]}</div>
        </div>
      </div>

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
