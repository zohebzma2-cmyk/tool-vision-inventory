import { useState, useEffect } from "react";
import { Printer, TestTube, LogOut, Share, Loader2, Download, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/adaptive-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { setupPrinter, testPrint, isPrintingSupported, printerService, connectorBase, getConnectorHost, setConnectorHost } from "@/components/inventory/PrinterService";
import { PaperTypeConfig } from "@/components/inventory/PaperTypeConfig";
import { exportInventoryCsv } from "@/lib/exportCsv";
import { haptic } from "@/lib/haptics";

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

  // Reflect the real printer state when Settings opens (the service is a singleton shared with the
  // Spaces tab), so it never falsely shows "Connect" while a printer is already live.
  useEffect(() => { if (open) setConnected(printerService.isConnected); }, [open]);

  // Printer connector (for the phone / iPad app to reach the computer's printer over Wi-Fi).
  const [connHost, setConnHost] = useState(getConnectorHost());
  const [detectedLan, setDetectedLan] = useState("");
  const [connOk, setConnOk] = useState<boolean | null>(null);

  const probeConnector = async () => {
    try {
      const res = await fetch(`${connectorBase()}/health`, { signal: AbortSignal.timeout(2500) });
      const j = await res.json().catch(() => ({}));
      const ok = !!res.ok && !!j.ok;   // a 200 from OUR connector, not just any server on that address
      setConnOk(ok);
      if (j.lan) setDetectedLan(`${j.lan}:${j.port || 17777}`);
      return ok;
    } catch {
      setConnOk(false);
      return false;
    }
  };
  useEffect(() => { if (open) { setConnHost(getConnectorHost()); probeConnector(); } }, [open]);

  const saveConnector = async () => {
    setConnectorHost(connHost);
    const ok = await probeConnector();
    toast(ok
      ? { title: "Connected to printer", description: "The app will print through this computer over Wi-Fi.", variant: "success" }
      : { title: "Not reachable", description: "Check the address, same Wi-Fi, and that the connector is running on the computer.", variant: "destructive" });
  };

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

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const count = await exportInventoryCsv();
      haptic.success();
      toast({
        title: count ? "Inventory exported" : "Nothing to export yet",
        description: count
          ? `Saved ${count} ${count === 1 ? "item" : "items"} to a spreadsheet file.`
          : "Add some tools first, then export.",
        variant: "success",
      });
    } catch {
      toast({ title: "Export failed", description: "Couldn't build the file. Try again.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold text-muted-foreground">
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

          {/* Printer connector: lets the phone / iPad print on the computer's Brother printer over
              Wi-Fi. On the computer this shows the address to type into the app on your phone. */}
          <section className="space-y-2">
            <h3 className="font-display text-sm font-semibold text-muted-foreground flex items-center gap-2">
              <Wifi className="h-4 w-4" /> Printer connector (phone / iPad)
            </h3>
            {detectedLan && (
              <p className="text-xs text-muted-foreground">
                This computer's printer address: <span className="font-mono text-foreground">{detectedLan}</span>
                {" "}— enter it in this field in the app on your phone.
              </p>
            )}
            <div className="flex gap-2">
              <Input
                inputMode="url"
                placeholder="192.168.1.50"
                value={connHost}
                onChange={(e) => setConnHost(e.target.value)}
              />
              <Button onClick={saveConnector}>Save</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {connOk === true
                ? "Connected — labels print on the computer's Brother printer."
                : connOk === false
                ? "Not reachable. Make sure the computer is on the same Wi-Fi with the connector running."
                : "Point the phone/iPad app at the computer running the printer connector."}
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-display text-sm font-semibold text-muted-foreground">
              Your inventory
            </h3>
            <Button variant="outline" className="w-full justify-start press" onClick={exportCsv} disabled={exporting}>
              {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Export everything (spreadsheet)
            </Button>
            <p className="text-xs text-muted-foreground">
              Saves a CSV of every tool, where it lives, and its details — opens in Excel, Numbers, or Google Sheets.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-display text-sm font-semibold text-muted-foreground">
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
