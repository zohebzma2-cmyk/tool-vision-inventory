import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Loader2, Check, Smartphone, ScanLine } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/adaptive-dialog";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { haptic } from "@/lib/haptics";

/**
 * Desktop can't run a LiDAR scan (no sensor), so instead of hiding the option we hand it to the
 * phone. The web and iOS apps share one account, so the user just opens this space in the iPhone
 * app and scans it — this dialog waits and picks up the result automatically.
 *
 * "Waiting" is implemented by polling the place row for a changed `layout.scan` (poll is
 * bulletproof and the dialog is short-lived); the shared-account realtime sync means the write
 * lands within a second of the phone finishing.
 */
interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  place: { id: string; name: string; layout?: Record<string, unknown> | null } | null;
  /** Called once the phone's scan has landed on this place, so the parent can reload. */
  onScanArrived: () => void;
}

const POLL_MS = 3000;

/** How many walls the place's scan currently has (-1 if there's no scan yet). */
function scanWallCount(layout: Record<string, unknown> | null | undefined): number {
  const scan = (layout as { scan?: { walls?: unknown[] } } | null | undefined)?.scan;
  return scan && Array.isArray(scan.walls) ? scan.walls.length : -1;
}

export function ContinueOnPhone({ open, onOpenChange, place, onScanArrived }: Props) {
  const [qr, setQr] = useState<string | null>(null);
  const [arrived, setArrived] = useState(false);
  const [checking, setChecking] = useState(false);
  const baseline = useRef<number>(-1);

  useEffect(() => {
    if (!open || !place) return;
    setArrived(false);
    baseline.current = scanWallCount(place.layout);
    // A QR to the app so the user can open it on their phone (scan= hints which space).
    const url = `${window.location.origin}/?scan=${encodeURIComponent(place.id)}`;
    QRCode.toDataURL(url, { margin: 1, scale: 5 }).then(setQr).catch(() => setQr(null));
  }, [open, place]);

  // Poll for the phone's scan to arrive while the dialog is open.
  useEffect(() => {
    if (!open || !place || arrived) return;
    let cancelled = false;
    const check = async () => {
      const { data } = await supabase.from("locations").select("layout").eq("id", place.id).single();
      if (cancelled || !data) return;
      const count = scanWallCount(data.layout as Record<string, unknown>);
      // Arrived if a scan now exists where there was none, or the wall count changed.
      if (count >= 0 && count !== baseline.current) {
        setArrived(true);
        haptic.success();
        onScanArrived();
      }
    };
    const id = window.setInterval(check, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, place, arrived, onScanArrived]);

  const checkNow = async () => {
    if (!place) return;
    setChecking(true);
    try {
      const { data } = await supabase.from("locations").select("layout").eq("id", place.id).single();
      const count = scanWallCount((data?.layout as Record<string, unknown>) ?? null);
      if (count >= 0 && count !== baseline.current) {
        setArrived(true);
        onScanArrived();
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <Smartphone className="h-5 w-5" /> Scan {place?.name} with your iPhone
          </DialogTitle>
        </DialogHeader>

        {arrived ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center animate-pop">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="h-7 w-7" />
            </span>
            <p className="font-display text-lg font-semibold">Scan received</p>
            <p className="text-sm text-muted-foreground">Your room came through. It's on the plan now.</p>
            <Button className="mt-2" onClick={() => onOpenChange(false)}>Done</Button>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-muted-foreground">
              Desktops can't run a LiDAR scan, so do it from the Tool Vision app on your iPhone — you're
              signed into the same account, so the scan shows up here automatically.
            </p>

            <ol className="space-y-2.5 text-sm">
              {[
                "Open the Tool Vision app on your LiDAR iPhone or iPad Pro.",
                `Go to Storage and open “${place?.name ?? "this space"}”.`,
                "Tap Scan with LiDAR and walk the room.",
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 font-display text-xs font-semibold text-primary">
                    {i + 1}
                  </span>
                  <span className="leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>

            {qr && (
              <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <img src={qr} alt="QR code to open Tool Vision on your phone" className="h-24 w-24 rounded" />
                <div className="text-xs text-muted-foreground">
                  <p className="font-display text-sm font-semibold text-foreground">Don't have it open?</p>
                  Scan this with your iPhone camera to open Tool Vision, then follow the steps above.
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 p-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Waiting for your iPhone's scan…
              </span>
              <Button variant="secondary" size="sm" onClick={checkNow} disabled={checking}>
                {checking ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ScanLine className="h-4 w-4 mr-2" />}
                Check now
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
