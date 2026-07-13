import { Sparkles, Camera, ScanLine, Grid2x2, ArrowRight } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/adaptive-dialog";
import { GUIDE_STEPS, GUIDE_HIERARCHY } from "./guideContent";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** The AI actions, in the order a new user meets them. */
const AI_ACTIONS = [
  { icon: Grid2x2, label: "Map a space", blurb: "Photo of a pegboard or shelf → a grid of slots." },
  { icon: Sparkles, label: "Detect items", blurb: "Boxes every tool on a board into its own spot." },
  { icon: Camera, label: "Fill a bin", blurb: "One photo lists everything inside a bin." },
  { icon: ScanLine, label: "Scan a QR", blurb: "Jump straight to what's stored at a label." },
];

/**
 * Always-available explainer of how the app works. Reachable from the header "?" at any time.
 * Reuses the first-run onboarding steps so there's one source of truth, and leads with the
 * Space → Location → Slot vocabulary so the rest of the app reads clearly.
 */
export function HowItWorks({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">How Tool Vision works</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Mental model */}
          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold text-muted-foreground">The layout, top to bottom</h3>
            <div className="flex items-stretch gap-2">
              {GUIDE_HIERARCHY.map((h, i) => (
                <div key={h.term} className="flex flex-1 items-stretch gap-2">
                  <div className="flex-1 rounded-lg border bg-card p-3 text-center animate-in-up" style={{ animationDelay: `${i * 60}ms` }}>
                    <h.icon className="mx-auto mb-1.5 h-5 w-5 text-primary" aria-hidden />
                    <div className="font-display text-sm font-semibold">{h.term}</div>
                    <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{h.blurb}</div>
                  </div>
                  {i < GUIDE_HIERARCHY.length - 1 && (
                    <ArrowRight className="my-auto h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* The three-step flow (shared with onboarding) */}
          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold text-muted-foreground">Getting started</h3>
            <div className="stagger space-y-2">
              {GUIDE_STEPS.map((s, i) => (
                <div key={s.title} className="flex gap-3 rounded-lg border bg-card p-3" style={{ "--i": i } as React.CSSProperties}>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <s.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <div>
                    <div className="font-display text-sm font-semibold">{s.title}</div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* What the AI can do */}
          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold text-muted-foreground">What the AI does</h3>
            <div className="grid grid-cols-2 gap-2">
              {AI_ACTIONS.map((a) => (
                <div key={a.label} className="rounded-lg border bg-card p-3">
                  <a.icon className="mb-1.5 h-4 w-4 text-primary" aria-hidden />
                  <div className="font-display text-xs font-semibold">{a.label}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{a.blurb}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
