// Quick Capture — the center-tab entry point for hands-on capture. Pick a bin, and it opens the
// right mode for the device: Overlay Scan on the iPad (cloud, no connector) or true Rapid Mode on
// the desktop station (voice + label printing). Keeps capture one tap from anywhere.

import { useEffect, useMemo, useState } from "react";
import { X, Loader2, ScanLine, Zap, Cable } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { isLabelOutputSupported } from "@/lib/brotherPrint";
import { Button } from "@/components/ui/button";
import { RapidMode } from "./RapidMode";
import { ScanMode } from "./ScanMode";
import { CableLabel } from "./CableLabel";

interface Bin { id: string; name: string; category?: string | null }

/** Natural sort so "Bin 2" comes before "Bin 10". */
function binOrder(a: Bin, b: Bin): number {
  const na = Number(a.name.match(/(\d+)/)?.[1] ?? NaN);
  const nb = Number(b.name.match(/(\d+)/)?.[1] ?? NaN);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.name.localeCompare(b.name);
}

export function QuickCapture({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [bins, setBins] = useState<Bin[] | null>(null);
  const [picked, setPicked] = useState<Bin | null>(null);
  const [cordOpen, setCordOpen] = useState(false);
  const [q, setQ] = useState("");
  const desktop = isLabelOutputSupported();

  useEffect(() => {
    if (!open) return;
    setPicked(null); setQ(""); setBins(null);
    supabase.from("locations").select("id,name,category").eq("type", "bin")
      .then(({ data }) => setBins(((data as Bin[]) || []).slice().sort(binOrder)));
  }, [open]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (bins || []).filter((b) => !t || b.name.toLowerCase().includes(t) || (b.category || "").toLowerCase().includes(t));
  }, [bins, q]);

  if (!open) return null;

  if (cordOpen) return <CableLabel open onOpenChange={(o) => { if (!o) { setCordOpen(false); onOpenChange(false); } }} />;

  // Once a bin is picked, hand off to the device-appropriate capture mode.
  if (picked) {
    const close = (o: boolean) => { if (!o) { setPicked(null); onOpenChange(false); } };
    return desktop
      ? <RapidMode open onOpenChange={close} bin={picked} />
      : <ScanMode open onOpenChange={close} bin={picked} />;
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b p-4">
        <div>
          <h2 className="font-display text-lg font-semibold">Capture into a bin</h2>
          <p className="text-xs text-muted-foreground">
            {desktop ? "Opens Rapid Mode (voice + printing)" : "Opens the overlay scanner"} · pick a bin
          </p>
        </div>
        <button onClick={() => onOpenChange(false)} className="rounded p-1.5 hover:bg-muted" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="border-b p-3 space-y-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bins…"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary" />
        <Button variant="secondary" className="w-full" onClick={() => setCordOpen(true)}>
          <Cable className="mr-2 h-4 w-4" /> Label a cord instead
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {bins === null ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading bins…
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No bins found. Create a bin wall in Storage first.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {filtered.map((b) => (
              <button key={b.id} onClick={() => setPicked(b)}
                className="press flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-muted/40">
                <span className="flex items-center gap-1.5 text-xs text-primary">
                  {desktop ? <Zap className="h-3.5 w-3.5" /> : <ScanLine className="h-3.5 w-3.5" />}
                </span>
                <span className="font-semibold">{b.name}</span>
                {b.category && <span className="truncate text-xs text-muted-foreground">{b.category}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
