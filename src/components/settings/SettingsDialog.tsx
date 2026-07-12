import { useState } from "react";
import { Printer, TestTube, LogOut, Share, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { setupPrinter, testPrint, isPrintingSupported } from "@/components/inventory/PrinterService";
import { PaperTypeConfig } from "@/components/inventory/PaperTypeConfig";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** App settings: label printer, paper, and account. */
export function SettingsDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const { user, signOut } = useAuth();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    const ok = await setupPrinter();
    setBusy(false);
    setConnected(ok);
    toast(ok
      ? { title: "Printer connected", description: "Brother printer ready — labels print directly." }
      : { title: "Connection failed", description: "Check the USB connection and try again.", variant: "destructive" });
  };

  const runTest = async () => {
    setBusy(true);
    const res = await testPrint();
    setBusy(false);
    toast({
      title: res.success ? "Test label sent" : "Test print failed",
      description: res.message,
      variant: res.success ? undefined : "destructive",
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-wide">Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Label printer
            </h3>
            {isPrintingSupported() ? (
              <>
                <div className="flex gap-2">
                  <Button variant={connected ? "secondary" : "default"} onClick={connect} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />}
                    {connected ? "Printer connected" : "Connect Brother printer"}
                  </Button>
                  {connected && (
                    <Button variant="outline" onClick={runTest} disabled={busy}>
                      <TestTube className="h-4 w-4 mr-2" /> Test print
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Plug the Brother printer in over USB, then connect. Labels print directly from the app.
                </p>
              </>
            ) : (
              <div className="rounded-md border p-3 text-sm text-muted-foreground flex gap-3">
                <Share className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
                <span>
                  On this device, label buttons open the <span className="text-foreground font-medium">share sheet</span> —
                  choose <span className="text-foreground font-medium">Print</span> (AirPrint) or the{" "}
                  <span className="text-foreground font-medium">Brother iPrint&amp;Label</span> app to print.
                  Direct USB printing is available in Chrome on a computer.
                </span>
              </div>
            )}
            <PaperTypeConfig onPaperTypeChange={() => { /* persisted by the component */ }} />
          </section>

          <section className="space-y-2">
            <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Account
            </h3>
            <div className="flex items-center justify-between gap-2 rounded-md border p-3">
              <span className="text-sm truncate">{user?.email}</span>
              <Button size="sm" variant="outline" onClick={signOut}>
                <LogOut className="h-4 w-4 mr-2" /> Sign out
              </Button>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
