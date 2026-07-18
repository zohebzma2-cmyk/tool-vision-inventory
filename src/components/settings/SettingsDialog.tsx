import { useState, useEffect } from "react";
import { Printer, TestTube, LogOut, Share, Loader2, Download, Wifi, Copy, Check } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/adaptive-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { setupPrinter, testPrint, isPrintingSupported, printerService, connectorBase, getConnectorHost, setConnectorHost, getLabelMedia, setLabelMedia } from "@/components/inventory/PrinterService";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { TAPE_PRESETS } from "@/lib/binLabel";
import { PaperTypeConfig } from "@/components/inventory/PaperTypeConfig";
import { exportInventoryCsv } from "@/lib/exportCsv";
import { haptic } from "@/lib/haptics";
import { onQueueChange, flushQueue } from "@/lib/printQueue";
import { RotateCw } from "lucide-react";

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

  // Labels that couldn't print yet (printer asleep / connector down) — retried automatically.
  const [pending, setPending] = useState(0);
  useEffect(() => onQueueChange(setPending), []);

  // Printer connector (for the phone / iPad app to reach the computer's printer over Wi-Fi).
  const [media, setMedia] = useState(getLabelMedia());
  const [connHost, setConnHost] = useState(getConnectorHost());
  const [detectedLan, setDetectedLan] = useState("");
  const [connOk, setConnOk] = useState<boolean | null>(null);
  const [connQueued, setConnQueued] = useState(0);        // labels waiting on the connector itself
  const [printerPresent, setPrinterPresent] = useState<boolean | null>(null);
  const [connectQr, setConnectQr] = useState("");         // QR another device scans to link to this Mac

  const probeConnector = async () => {
    try {
      const res = await fetch(`${connectorBase()}/health`, { signal: AbortSignal.timeout(2500) });
      const j = await res.json().catch(() => ({}));
      const ok = !!res.ok && !!j.ok;   // a 200 from OUR connector, not just any server on that address
      setConnOk(ok);
      setConnQueued(Number(j.queued) || 0);
      setPrinterPresent(typeof j.printerPresent === "boolean" ? j.printerPresent : null);
      // Prefer the stable mDNS .local name (survives DHCP IP changes); fall back to the raw LAN IP.
      if (j.host) setDetectedLan(`${j.host}:${j.port || 17777}`);
      else if (j.lan) setDetectedLan(`${j.lan}:${j.port || 17777}`);
      return ok;
    } catch {
      setConnOk(false);
      return false;
    }
  };
  useEffect(() => { if (open) { setConnHost(getConnectorHost()); probeConnector(); } }, [open]);
  // Build the "scan to connect" QR from this computer's connector address, so another device links
  // by scanning instead of typing. Only meaningful where we can see the connector (detectedLan set).
  useEffect(() => {
    if (!detectedLan) { setConnectQr(""); return; }
    QRCode.toDataURL(`tvconn:${detectedLan}`, { margin: 1, scale: 5 }).then(setConnectQr).catch(() => setConnectQr(""));
  }, [detectedLan]);

  const saveConnector = async () => {
    setConnectorHost(connHost);
    const ok = await probeConnector();
    toast(ok
      ? { title: "Connected to printer", description: "The app will print through this computer over Wi-Fi.", variant: "success" }
      : { title: "Not reachable", description: "Check the address, same Wi-Fi, and that the connector is running on the computer.", variant: "destructive" });
  };

  // One-line installer that sets up + starts the desktop connector on the user's Mac.
  const INSTALL_CMD = "curl -fsSL https://raw.githubusercontent.com/zohebzma2-cmyk/tool-vision-inventory/main/desktop-connector/install.sh | bash";
  const [copied, setCopied] = useState(false);
  const copyInstall = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ title: "Copy failed", description: "Select the command and copy it manually.", variant: "destructive" });
    }
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
            {connOk === true && printerPresent === true ? (
              <div className="flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
                <Check className="h-4 w-4 text-green-600" /> Printer ready — labels print on this Mac.
                <Button variant="outline" size="sm" className="ml-auto h-7" onClick={runTest} disabled={busy}>
                  <TestTube className="mr-1 h-3.5 w-3.5" /> Test
                </Button>
              </div>
            ) : connOk === false ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                Can’t reach a printer from here. On the Mac with the printer, open{" "}
                <a href="http://localhost:17777" className="font-mono underline">http://localhost:17777</a>{" "}
                — that version prints. Labels you scan on other devices print there automatically.
              </div>
            ) : isPrintingSupported() ? (
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

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Tape / label size</Label>
              <Select value={media} onValueChange={(v) => { setMedia(v); setLabelMedia(v); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TAPE_PRESETS).map(([id, p]) => (
                    <SelectItem key={id} value={id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Must match the tape loaded in the printer. Used for bin-label printing (barcode labels).
              </p>
            </div>

            {pending > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                <span className="text-sm">
                  {pending} label{pending === 1 ? "" : "s"} waiting to print — retrying automatically.
                </span>
                <Button size="sm" variant="outline" onClick={() => flushQueue()}>
                  <RotateCw className="h-4 w-4 mr-1.5" /> Retry now
                </Button>
              </div>
            )}
            {connQueued > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                {connQueued} label{connQueued === 1 ? "" : "s"} queued on the computer
                {printerPresent === false ? " — will print automatically when the Brother printer is reconnected." : " — printing…"}
              </div>
            )}
          </section>

          {/* Connect your Mac: a one-line installer sets up + starts the connector so the app can
              print (and use the webcam/voice) on this computer. */}
          <section className="space-y-2">
            <h3 className="font-display text-sm font-semibold text-muted-foreground flex items-center gap-2">
              <Wifi className="h-4 w-4" /> Connect your Mac
            </h3>

            {connOk === true ? (
              <>
                <div className="flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
                  <Check className="h-4 w-4 text-green-600" />
                  Connected{detectedLan ? <> — <span className="font-mono text-foreground">{detectedLan}</span></> : ""}. Labels print on this Mac.
                </div>
                {connectQr && (
                  <div className="flex items-center gap-3 rounded-md border p-3">
                    <img src={connectQr} alt="Scan to connect" className="h-24 w-24 shrink-0 rounded bg-white p-1" />
                    <div className="text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">Scan to connect a device</p>
                      <p className="mt-1">In the app on your phone, open the QR scanner and scan this to link it to this printer.</p>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Run this once in your Mac's <span className="text-foreground font-medium">Terminal</span> — it installs and starts the connector, then the app links automatically:
                </p>
                <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2">
                  <code className="flex-1 break-all font-mono text-[11px] leading-relaxed">{INSTALL_CMD}</code>
                  <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" onClick={copyInstall}>
                    {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Leave that window open while you use the app. It auto-connects on this computer.
                </p>
              </>
            )}

            {/* Phone / iPad: point at the Mac's address (advanced / when not auto-detected). */}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Connect a phone or iPad manually</summary>
              <div className="mt-2 space-y-2">
                {detectedLan && (
                  <p>This Mac's address: <span className="font-mono text-foreground">{detectedLan}</span> — enter it in the app on your phone/iPad (the <span className="font-mono">.local</span> name survives Wi-Fi IP changes).</p>
                )}
                <div className="flex gap-2">
                  <Input inputMode="url" placeholder="192.168.1.50" value={connHost} onChange={(e) => setConnHost(e.target.value)} />
                  <Button onClick={saveConnector}>Save</Button>
                </div>
              </div>
            </details>
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
