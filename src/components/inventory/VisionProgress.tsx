import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One shared "AI is thinking" experience used by every vision call (map a space, detect spots,
 * fill a bin, identify an item, generate a blueprint). It replaces the bare `<Loader2 spin/> …`
 * spinners so that:
 *   - the wait is visually alive (a scan band sweeps the submitted photo, or a branded grid
 *     breathes when there's no photo),
 *   - the copy teaches what the model is doing by cycling through per-call stage captions,
 *   - a long wait is honest — after ~15s it says the self-hosted model can take up to a minute,
 *     matching the real 60–90s fallback latency (cloud is usually 2–4s).
 *
 * Reduced-motion: the global `prefers-reduced-motion` guard neutralizes the CSS sweep, and we also
 * drop the animated overlay in JS, leaving a calm static frame. The captions still advance (a text
 * change every couple seconds is informative, not vestibular motion) so progress stays legible.
 */
interface Props {
  /** The image being analyzed. When present it's shown with a scanning band sweeping over it. */
  imageDataUrl?: string | null;
  /** Ordered captions describing what the model does; they cycle and hold on the last. */
  stages: string[];
  className?: string;
}

const STAGE_MS = 2000;
const LONG_WAIT_MS = 15000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function VisionProgress({ imageDataUrl, stages, className }: Props) {
  const reduced = usePrefersReducedMotion();
  const [stage, setStage] = useState(0);
  const [longWait, setLongWait] = useState(false);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    setStage(0);
    setLongWait(false);
    const id = window.setInterval(
      () => setStage((s) => Math.min(s + 1, stages.length - 1)),
      STAGE_MS,
    );
    const longTimer = window.setTimeout(() => setLongWait(true), LONG_WAIT_MS);
    return () => { window.clearInterval(id); window.clearTimeout(longTimer); };
    // Restart the sequence whenever the caption set changes (i.e. a new AI call begins).
  }, [stages]);

  const caption = stages[stage] ?? stages[stages.length - 1] ?? "Working…";
  const animate = !reduced;

  return (
    <div className={cn("flex flex-col items-center gap-3 py-6 text-center", className)} role="status" aria-live="polite">
      <div className="relative h-40 w-full max-w-xs overflow-hidden rounded-xl border-2 border-tile bg-card">
        {imageDataUrl ? (
          <>
            <img src={imageDataUrl} alt="" className="h-full w-full object-cover opacity-90" />
            <div className="absolute inset-0 bg-gradient-to-b from-background/10 to-background/40" />
            {animate && <span className="tv-scan-line" aria-hidden />}
          </>
        ) : (
          // No photo (e.g. a described blueprint): a breathing pegboard-dot field.
          <div
            className={cn(
              "absolute inset-0",
              animate && "tv-breathe",
            )}
            style={{
              backgroundImage: "radial-gradient(hsl(var(--muted-foreground) / 0.5) 1.5px, transparent 1.5px)",
              backgroundSize: "16px 16px",
            }}
            aria-hidden
          />
        )}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-soft",
            animate && "animate-pop",
          )}>
            <Sparkles className="h-5 w-5" />
          </span>
        </div>
      </div>

      <div className="min-h-[2.5rem]">
        <p key={caption} className={cn("font-display text-sm font-semibold", animate && "animate-in-up")}>
          {caption}
        </p>
        {longWait && (
          <p className="mt-1 text-xs text-muted-foreground">
            The self-hosted model is thinking — this can take up to a minute.
          </p>
        )}
      </div>

      {/* Slim progress track: fills as stages advance so there's a sense of forward motion. */}
      <div className="h-1 w-40 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
          style={{ width: `${((stage + 1) / stages.length) * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Canonical caption sets — kept here so every call site stays consistent and teaches the flow. */
export const VISION_STAGES = {
  mapSpace: ["Looking at your photo", "Finding the storage unit", "Counting rows & columns", "Placing the grid"],
  detectSpots: ["Scanning the surface", "Finding each tool", "Boxing every spot"],
  identifyBin: ["Opening the bin", "Reading labels", "Listing every item"],
  identifyItem: ["Focusing on the tool", "Reading brand & model", "Looking it up"],
  generateBlueprint: ["Reading your sketch", "Measuring the room", "Placing storage zones"],
} as const;
