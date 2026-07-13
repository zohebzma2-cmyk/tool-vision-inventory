import { useState } from "react";
import { Camera, Grid3x3, ArrowRight, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GUIDE_STEPS as STEPS } from "./guideContent";

export interface OnboardingProps {
  onFinish: (action: "map-space" | "add-tool" | "done") => void;
}

/** First-run walkthrough. Rendered as a full-screen pane over the app shell. */
export function Onboarding({ onFinish }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;
  const { icon: Icon, title, body } = STEPS[step];

  return (
    <div
      className="fixed inset-0 z-50 bg-background pegboard flex flex-col"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Tool Vision"
    >
      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 text-center">
        <div className="label-tile border border-tile-edge px-4 py-2 mb-8 flex items-center gap-2 text-sm">
          <Wrench className="h-4 w-4" aria-hidden />
          Welcome to Tool Vision
        </div>

        <div className="label-tile flex items-center justify-center h-20 w-20 mb-6 border border-tile-edge">
          <Icon className="h-10 w-10 text-primary" aria-hidden />
        </div>

        <h1 className="font-display text-3xl font-bold mb-3">{title}</h1>
        <p className="text-muted-foreground max-w-sm leading-relaxed">{body}</p>

        {/* Step dots */}
        <div className="flex gap-2 mt-8" aria-hidden>
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === step ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/30",
              )}
            />
          ))}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-6 space-y-3 max-w-sm w-full mx-auto">
        {last ? (
          <>
            <Button className="w-full" size="lg" onClick={() => onFinish("map-space")}>
              <Grid3x3 className="h-4 w-4 mr-2" />
              Map my first space
            </Button>
            <Button variant="secondary" className="w-full" size="lg" onClick={() => onFinish("add-tool")}>
              <Camera className="h-4 w-4 mr-2" />
              Add a tool instead
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => onFinish("done")}>
              I'll explore on my own
            </Button>
          </>
        ) : (
          <>
            <Button className="w-full" size="lg" onClick={() => setStep(step + 1)}>
              Next
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => onFinish("done")}>
              Skip
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
