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
import { persistInventoryImage } from "@/lib/imageStorage";
import { noteSessionItem } from "@/lib/sessionPrints";
import { isLabelOutputSupported } from "@/lib/brotherPrint";
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

type Phase = "starting" | "setup" | "scanning" | "captured" | "identifying" | "confirming" | "saving" | "finishing" | "error";

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
  /** Is the session loop actually running? Decides whether Close can be graceful or must be direct. */
  const loopAliveRef = useRef(false);
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

    // Zoom all the way out for the widest field of view (best for the top-down iPad framing).
    const applyWidest = async (s: MediaStream) => {
      try {
        const track = s.getVideoTracks()[0];
        const caps = track?.getCapabilities?.() as { zoom?: { min?: number } } | undefined;
        if (caps?.zoom?.min != null) {
          await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] } as unknown as MediaTrackConstraints);
        }
      } catch { /* zoom not supported on this camera */ }
    };

    // --- camera + mic ---
    const startMedia = async (): Promise<MediaStream> => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      // DESKTOP STATION ONLY: prefer an external USB webcam (Logitech/Brio/C920…). On a phone/iPad this
      // logic wrongly grabs the FRONT camera (it isn't "FaceTime/built-in"), so it's gated to the
      // desktop — where a USB cam actually exists. On mobile, facingMode:"environment" is the rear cam.
      if (isLabelOutputSupported()) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cams = devices.filter((d) => d.kind === "videoinput");
          const ext = cams.find((d) => /logitech|brio|c9\d\d|webcam|uvc|razer|elgato|streamcam|hd pro|vendorid_1133/i.test(d.label))
            || cams.find((d) => d.label && !/facetime|built-?in|iphone|continuity|desk\s*view|front/i.test(d.label));
          const currentId = stream.getVideoTracks()[0]?.getSettings().deviceId;
          if (ext && ext.deviceId && ext.deviceId !== currentId) {
            const better = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: ext.deviceId }, width: { ideal: 1280 } },
              audio: { echoCancellation: true, noiseSuppression: true },
            });
            stream.getTracks().forEach((t) => t.stop()); // safe now: `better` is live
            await applyWidest(better);
            return better;
          }
        } catch { /* switch failed — the original stream is still live, keep it */ }
      }
      await applyWidest(stream);
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
        if (watched >= 6000) {                 // periodic voice window to say "done"
          watched = 0;
          // Deliberately NOT gated on a quiet scene. `moved` latches on the first motion spike and
          // only clears on a capture, so any continuous low-level motion — a shop fan, someone
          // walking behind the camera, flickering fluorescents — used to hold it true forever and
          // silently kill the ONLY voice way out of the session. Six seconds without settling means
          // no item is being presented, so re-arm and let the user speak.
          moved = false; steady = 0;
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
    // Returns false if any copy was neither printed nor safely queued. printResilient reports that
    // via `queued: false` (localStorage full — a long session of queued PNGs exhausts the ~5MB quota
    // well before the 300-job cap). Ignoring it told the user "Labeled X" while the label was gone
    // with no trace, so the tool goes on the shelf bare and nothing ever says so.
    const printCopies = async (dataUrl: string, media: string, name: string, copies: number) => {
      let allSafe = true;
      for (let i = 0; i < Math.max(1, copies); i++) {
        const res = await printResilient(dataUrl, media, copies > 1 ? `${name} (${i + 1}/${copies})` : name);
        if (!res.success && !res.queued) allSafe = false;
      }
      return allSafe;
    };

    const saveAndPrint = async (
      item: { name: string; category?: string; brand?: string; model?: string; text?: string }, frame: string, qty: number,
      logoP: Promise<HTMLImageElement | null>,
    ): Promise<{ merged: boolean; total?: number; noLabel?: boolean; labelDropped?: boolean }> => {
      // Already in this bin? Bump its quantity instead of creating a duplicate row — but still print a
      // label for each newly-added physical unit so every one on the shelf is labeled.
      const dup = await findItemInBin(bin!.id, item.name);
      if (dup) {
        const total = await mergeQuantity(dup, qty);
        lastCreated = null; // a merge isn't a fresh row to undo
        // Items created outside Rapid Mode (Add Tool, the assistant, an import) can have no qr_code.
        // Skipping the print in that case put an unlabeled unit on the shelf while still announcing
        // success, so mint a code for the existing row and label it like any other unit.
        let code = dup.code;
        if (!code) {
          code = await mintShortCode();
          const { error } = await supabase.from("items").update({ qr_code: code }).eq("id", dup.id);
          if (error) code = null; // couldn't claim a code — fall through and report it below
        }
        if (!code) return { merged: true, total, labelDropped: true };
        const media = getLabelMedia();
        const label = renderItemLabel({ name: dup.name, code, sub: [], media, logo: await logoP }).toDataURL("image/png");
        const labelSafe = await printCopies(label, media, dup.name, qty);
        return { merged: true, total, labelDropped: !labelSafe };
      }
      // If the package already carries a real barcode (UPC/EAN in the OCR), store the item with its
      // SKU and DON'T print a Tool Vision label — that's the owner's rule for SKU'd parts.
      const upc = (item.text || "").match(/\b(\d{12,14})\b/)?.[1];
      const code = await mintShortCode();
      const media = getLabelMedia();
      const photoUrl = await persistInventoryImage(frame, "item"); // → Storage URL (or inline, if bucket absent)
      const insert: Record<string, unknown> = {
        name: item.name, category: item.category || "other", quantity: qty,
        quantity_unit: "piece", qr_code: code, photo_path: photoUrl,
      };
      if (upc) insert.notes = `UPC ${upc}`;
      if (item.brand) insert.brand = item.brand;
      if (item.model) insert.model = item.model;
      // The item photo is part of the record — a save failure must surface, never be silently retried
      // without the image (that would ship an imageless item that looks fine). Fail loud instead.
      const { data: created, error } = await supabase.from("items").insert(insert).select("id").single();
      if (error) throw error;
      // Claim it as ours BEFORE any further await — the realtime INSERT echo can reach the auto-print
      // bridge during the item_locations round-trip below; marking it synchronously here prevents a
      // second (duplicate) label. Rapid Mode prints its own label just after.
      noteSessionItem(created!.id);
      // Claim it for undo BEFORE the link attempt. If filing fails we tell the user we couldn't save
      // it, so "undo" must reach THIS row — otherwise undo silently deletes the previous tool instead.
      lastCreated = { id: created!.id, name: item.name };
      // Filing the item into the bin is the whole point — a failure here must surface, not be swallowed.
      const { error: linkErr } = await supabase
        .from("item_locations").insert({ item_id: created!.id, location_id: bin!.id, quantity: qty });
      if (linkErr) {
        // Roll the item back rather than stranding it: an unfiled row is invisible in every bin view
        // and would only ever resurface as a mysterious "homeless" item days later.
        await supabase.from("items").delete().eq("id", created!.id);
        lastCreated = null;
        throw linkErr;
      }
      if (item.category) labeledCategories.push(item.category);
      if (upc) return { merged: false, noLabel: true }; // SKU'd part — stored with its UPC, no TV label
      const sub = [item.category, [item.brand, item.model].filter(Boolean).join(" "), qty > 1 ? `×${qty}` : ""]
        .filter(Boolean) as string[];
      const label = renderItemLabel({ name: item.name, code, sub, media, logo: await logoP }).toDataURL("image/png");
      const labelSafe = await printCopies(label, media, item.name, qty); // ×N → one label per unit
      return { merged: false, labelDropped: !labelSafe };
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
        .from("locations").select("qr_code,slot_index,category,parent_location_id,layout").eq("id", bin!.id).maybeSingle();
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
      // Match the rest of the account's bin labels: use the stored bin number (layout.binNumber) or
      // slot_index+1 — NOT digits stripped from the whole name (a "Bin 4 — 6.5qt tote" name would
      // otherwise render as "465"). Fall back to the FIRST number in the name only.
      const layout = (b as { layout?: { binNumber?: number } }).layout || {};
      const slotIdx = (b as { slot_index?: number }).slot_index;
      const num = Number(layout.binNumber)
        || (slotIdx != null ? slotIdx + 1 : parseInt(bin!.name.match(/\d+/)?.[0] || "", 10))
        || 1;
      const canvas = renderBinLabel({
        number: num, code: (b as { qr_code?: string }).qr_code || `BIN${num}`, location, category, media,
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

      // Pre-flight: get a clean, well-lit shot before scanning — it makes ID + auto-capture reliable.
      setPhase("setup");
      await say(`Rapid mode for ${bin!.name}. Clear the bench, aim the camera at a clean, well-lit spot, and give it some room. Hold up one tool at a time.`);
      await sleep(1600);
      if (!aliveRef.current || finishRef.current) { await finishSession(); return; }
      await say("Show me your first item.");
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
            // A merged unit is still a unit handled this session — the badge counted only fresh
            // rows, so presenting the same tool twice made the running total drift low.
            countRef.current += 1; setCount(countRef.current);
            await say(
              r.labelDropped
                ? `You already have ${item.name} here — now ${r.total}, but its label didn't print.`
                : `You already have ${item.name} here — now ${r.total}.`
            );
          } else if (r.noLabel) {
            countRef.current += 1; setCount(countRef.current);
            await say(`${item.name} has a barcode — stored without a new label.`);
          } else if (r.labelDropped) {
            // Saved, but the label could not even be queued. Say so out loud — the whole point of a
            // hands-free flow is that the user isn't watching the screen.
            countRef.current += 1; setCount(countRef.current);
            await say(`Saved ${item.name}, but its label didn't print. Reprint it from the bin later.`);
            toast({
              title: "Label not printed",
              description: `${item.name} was saved, but the label couldn't be printed or queued. Print it from the bin.`,
              variant: "destructive",
            });
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

    // The loop owns the graceful exit (finish the current tool, print the bin label, close). Track
    // whether it is actually running, because every path that leaves it early — vision not
    // configured, camera denied, or an unexpected throw — used to leave the fullscreen overlay with
    // nothing able to close it, and a station flow meant to run without a keyboard became a reload.
    loopAliveRef.current = true;
    run()
      .catch((e) => {
        // e.g. the USB webcam is unplugged mid-session and drawImage throws on a dead track.
        setErrorMsg(
          `Rapid Mode stopped: ${String((e as Error)?.message || e)}. Your saved tools are safe — close and reopen to carry on.`
        );
        setPhase("error");
      })
      .finally(() => { loopAliveRef.current = false; });

    return () => {
      aliveRef.current = false;
      loopAliveRef.current = false;
      stopSpeaking();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      prevGrayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bin?.id]);

  /**
   * Close button / X. When the session loop is running we ask it to wind down gracefully so the
   * current tool is finished and the bin label still prints. When it ISN'T running there is nobody
   * left to honour that flag, so close outright — otherwise the overlay is a dead end.
   */
  const finishNow = () => {
    if (loopAliveRef.current) { finishRef.current = true; return; }
    stopSpeaking();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    onOpenChange(false);
  };

  if (!open) return null;

  const phaseLabel: Record<Phase, string> = {
    starting: "Starting camera…",
    setup: "Set up your space",
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
          {phase === "setup" && (
            <ul className="text-left text-sm text-white/85 space-y-2 bg-black/45 rounded-xl px-5 py-4 backdrop-blur-sm border border-white/15 max-w-xs">
              <li className="flex gap-2"><span className="text-primary">•</span> Clear the bench — plain background works best</li>
              <li className="flex gap-2"><span className="text-primary">•</span> Good, even light (avoid shadows &amp; glare)</li>
              <li className="flex gap-2"><span className="text-primary">•</span> Aim the webcam at the spot, with some room</li>
              <li className="flex gap-2"><span className="text-primary">•</span> One tool at a time, held steady</li>
            </ul>
          )}
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
