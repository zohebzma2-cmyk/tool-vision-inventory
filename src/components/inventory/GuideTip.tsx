import { useState } from "react";
import { Lightbulb, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A small, dismissible inline coaching hint for empty states and first-time moments.
 * Dismissal persists per `tipKey` in localStorage (convention: `tv-tip:<key>`), matching the
 * onboarding-persistence pattern, so a tip a user has acknowledged never nags again.
 */
interface Props {
  tipKey: string;
  children: React.ReactNode;
  className?: string;
}

const storageKey = (k: string) => `tv-tip:${k}`;

export function GuideTip({ tipKey, children, className }: Props) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey(tipKey)) === "1";
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey(tipKey), "1");
    } catch {
      /* private mode / storage disabled — just hide for this session */
    }
    setDismissed(true);
  };

  return (
    <div
      className={cn(
        "animate-in-up flex items-start gap-2.5 rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm",
        className,
      )}
      role="note"
    >
      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <p className="flex-1 leading-relaxed text-foreground/90">{children}</p>
      <button
        type="button"
        onClick={dismiss}
        className="press -m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss tip"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
