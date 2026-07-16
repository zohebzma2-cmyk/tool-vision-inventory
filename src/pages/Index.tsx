import { useEffect, useState } from "react";
import { Plus, Package, MapPin, LayoutGrid, ScanLine, Settings, Wrench, HelpCircle, Sparkles, Home, ArrowRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { AddItemDialog } from "@/components/inventory/AddItemDialog";
import { ItemsList } from "@/components/inventory/ItemsList";
import { LocationsList } from "@/components/inventory/LocationsList";
import { QRScanner } from "@/components/inventory/QRScanner";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { HowItWorks } from "@/components/onboarding/HowItWorks";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { FindMode } from "@/components/inventory/FindMode";
import { SortMode } from "@/components/inventory/SortMode";
import { computeOrgReport } from "@/lib/organize";
import { maybeRunWeeklyDigest } from "@/lib/digest";
import { useInventoryStats } from "@/hooks/useInventoryStats";
import { useRealtimeSync } from "@/hooks/useRealtimeSync";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { cn } from "@/lib/utils";
import { haptic } from "@/lib/haptics";
import { leadsWithScanner } from "@/lib/platform";

type Tab = "home" | "items" | "locations" | "overview" | "sort";

const Index = () => {
  const [showAddItem, setShowAddItem] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [scanCode, setScanCode] = useState<string | undefined>(undefined);
  const [showHelp, setShowHelp] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [sortCount, setSortCount] = useState(0);
  const [openMapOnLocations, setOpenMapOnLocations] = useState(false);
  const { user } = useAuth();
  const stats = useInventoryStats();

  // Live sync across every signed-in device (desktop <-> phone), instant.
  const [syncTick, setSyncTick] = useState(0);
  useRealtimeSync(["items", "locations", "item_locations"], () => {
    stats.refresh();
    setSyncTick((t) => t + 1);
  });

  // A USB barcode/QR scanner (keyboard-wedge) on the laptop: a scan opens the scanner dialog with
  // the code already resolved — same lookup + result UI as the camera, no camera needed.
  useBarcodeScanner((code) => {
    setScanCode(code);
    setShowQRScanner(true);
  });

  // Sort Mode badge: how many organization suggestions are outstanding (spaces filling up, items out
  // of place / with no home). Recomputed whenever inventory changes so the header nudge stays live.
  useEffect(() => {
    let cancelled = false;
    computeOrgReport()
      .then((r) => { if (!cancelled) setSortCount(r.suggestions.length); })
      .catch(() => { /* non-fatal — the badge just stays at its last value */ });
    return () => { cancelled = true; };
  }, [syncTick]);

  // Weekly organization digest: self-throttles to once a week, texts (via the Mac connector) + emails
  // when there's something to tidy. Fires once per app open for the signed-in user; silent otherwise.
  useEffect(() => {
    if (user?.id) maybeRunWeeklyDigest(user.id);
  }, [user?.id]);

  // First-run onboarding: once per account, and only while the wall is empty.
  const onboardKey = user ? `tv-onboarded:${user.id}` : null;
  const [onboarded, setOnboarded] = useState(true);
  useEffect(() => {
    if (onboardKey) setOnboarded(!!localStorage.getItem(onboardKey));
  }, [onboardKey]);

  // Keep the header counts honest as the user moves between sections.
  useEffect(() => {
    stats.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const showOnboarding =
    !onboarded && !stats.loading && stats.itemCount === 0 && stats.locationCount === 0;

  const finishOnboarding = (action: "map-space" | "add-tool" | "done") => {
    if (onboardKey) localStorage.setItem(onboardKey, "1");
    setOnboarded(true);
    if (action === "map-space") {
      setTab("locations");
      setOpenMapOnLocations(true);
    } else if (action === "add-tool") {
      setShowAddItem(true);
    }
  };

  const fmtMoney = (n: number) =>
    n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`;

  return (
    // Fixed-height app shell: header and bottom bar are flex siblings, only <main>
    // scrolls. position:fixed/sticky misbehave under iOS WebView rubber-banding.
    <div className="relative h-dvh flex flex-col bg-background pegboard">
      {/* Graphite header band — the wall the tiles hang on */}
      <header
        className="bg-tile text-tile-foreground border-b border-tile-edge shrink-0 z-40"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="container mx-auto px-4 py-3 md:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="label-tile flex items-center justify-center h-10 w-10 shrink-0 border border-tile-edge">
                <Wrench className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight leading-none truncate">
                  Tool Vision
                </h1>
                <p className="font-mono text-[11px] md:text-xs text-tile-foreground/60 mt-1 truncate">
                  {stats.loading
                    ? (leadsWithScanner ? "scan · remote" : "reading the wall…")
                    : [
                        `${stats.itemCount} tools`,
                        `${stats.locationCount} locations`,
                        ...(stats.totalValue > 0 ? [`${fmtMoney(stats.totalValue)} on the wall`] : []),
                      ].join(" · ")}
                </p>
              </div>
            </div>

            {/* Desktop actions */}
            <div className="hidden md:flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setShowFind(true)}
                className="bg-transparent border-tile-edge text-tile-foreground hover:bg-tile-foreground/10 hover:text-tile-foreground"
              >
                <Search className="h-4 w-4 mr-2" />
                Find
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowQRScanner(true)}
                className="bg-transparent border-tile-edge text-tile-foreground hover:bg-tile-foreground/10 hover:text-tile-foreground"
              >
                <ScanLine className="h-4 w-4 mr-2" />
                Scan label
              </Button>
              <Button onClick={() => setShowAddItem(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add tool
              </Button>
              <SortNavButton count={sortCount} onClick={() => setTab("sort")} />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowHelp(true)}
                title="How it works"
                className="text-tile-foreground/70 hover:bg-tile-foreground/10 hover:text-tile-foreground"
              >
                <HelpCircle className="h-4 w-4" />
                <span className="sr-only">How it works</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowSettings(true)}
                title="Settings"
                className="text-tile-foreground/70 hover:bg-tile-foreground/10 hover:text-tile-foreground"
              >
                <Settings className="h-4 w-4" />
                <span className="sr-only">Settings</span>
              </Button>
            </div>

            {/* Mobile: find + sort + help + settings — primary actions live in the bottom bar */}
            <div className="flex items-center gap-1 md:hidden">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowFind(true)}
                title="Find a tool"
                className="text-tile-foreground/70 hover:bg-tile-foreground/10 hover:text-tile-foreground"
              >
                <Search className="h-4 w-4" />
                <span className="sr-only">Find a tool</span>
              </Button>
              <SortNavButton count={sortCount} onClick={() => setTab("sort")} />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowHelp(true)}
                title="How it works"
                className="text-tile-foreground/70 hover:bg-tile-foreground/10 hover:text-tile-foreground"
              >
                <HelpCircle className="h-4 w-4" />
                <span className="sr-only">How it works</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowSettings(true)}
                title="Settings"
                className="text-tile-foreground/70 hover:bg-tile-foreground/10 hover:text-tile-foreground"
              >
                <Settings className="h-4 w-4" />
                <span className="sr-only">Settings</span>
              </Button>
            </div>
          </div>

          {/* Desktop tab rail */}
          <nav className="hidden md:flex gap-1 mt-4 -mb-px" aria-label="Sections">
            {(
              [
                { id: "home", label: "Home", icon: Home },
                { id: "items", label: "Tools", icon: Package },
                { id: "locations", label: "Storage", icon: MapPin },
                { id: "sort", label: "Sort", icon: Sparkles },
                { id: "overview", label: "Overview", icon: LayoutGrid },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                aria-current={tab === id ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 font-display text-[15px] font-semibold rounded-t border-b-2 transition-colors",
                  tab === id
                    ? "border-primary text-tile-foreground"
                    : "border-transparent text-tile-foreground/55 hover:text-tile-foreground"
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="relative flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
        <div className="container mx-auto px-3 md:px-4 py-4 md:py-6 pb-[calc(env(safe-area-inset-bottom)+88px)] md:pb-8">
        {/* No per-tab entrance animation — a native tab bar swaps content instantly, not with
            a fade-up on every tap (that reads web-y). */}
        <div className="bg-card rounded-lg shadow-soft border">
          {tab === "home" && (
            <HomeDashboard
              stats={stats}
              sortCount={sortCount}
              onNavigate={setTab}
              onAddTool={() => setShowAddItem(true)}
              onScan={() => setShowQRScanner(true)}
              onMapSpace={() => { setTab("locations"); setOpenMapOnLocations(true); }}
              onSettings={() => setShowSettings(true)}
              onHelp={() => setShowHelp(true)}
            />
          )}
          {tab === "items" && (
            <ItemsList syncSignal={syncTick} />
          )}
          {tab === "locations" && (
            <LocationsList
              syncSignal={syncTick}
              openMapOnMount={openMapOnLocations}
              onMapOpened={() => setOpenMapOnLocations(false)}
            />
          )}
          {tab === "sort" && (
            <div className="p-3 md:p-5">
              <SortMode syncSignal={syncTick} />
            </div>
          )}
          {tab === "overview" && (
            <Overview
              stats={stats}
              onAddTool={() => setShowAddItem(true)}
            />
          )}
        </div>
        </div>
      </main>

      {/* Mobile bottom bar — iOS-style translucent blur; content scrolls beneath it.
          Absolutely positioned inside the fixed-height shell, so it still can't move. */}
      <nav
        className="md:hidden absolute bottom-0 inset-x-0 z-40 bg-tile/85 backdrop-blur-xl backdrop-saturate-150 text-tile-foreground border-t border-tile-edge/60"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Primary"
      >
        <div className="grid grid-cols-5 items-stretch">
          <MobileTab
            active={tab === "items"}
            onClick={() => setTab("items")}
            icon={Package}
            label="Tools"
          />
          <MobileTab
            active={tab === "locations"}
            onClick={() => setTab("locations")}
            icon={MapPin}
            label="Storage"
          />
          {/* Center hero: Home dashboard (replaces the old Scan hero) — Scan, Add, and every page
              are one tap away from inside it. */}
          <button
            onClick={() => { haptic.medium(); setTab("home"); }}
            className="flex flex-col items-center justify-center gap-0.5 py-2 active:opacity-60"
            aria-label="Home"
          >
            <span className={cn(
              "flex items-center justify-center h-9 w-9 rounded shadow-soft",
              tab === "home" ? "bg-primary text-primary-foreground ring-2 ring-primary/30" : "bg-primary text-primary-foreground"
            )}>
              <Home className="h-5 w-5" aria-hidden />
            </span>
            <span className="font-display text-[11px] font-medium tracking-tight">
              Home
            </span>
          </button>
          <MobileTab active={false} onClick={() => setShowAddItem(true)} icon={Plus} label="Add" />
          <MobileTab
            active={tab === "overview"}
            onClick={() => setTab("overview")}
            icon={LayoutGrid}
            label="Overview"
          />
        </div>
      </nav>

      <AddItemDialog
        open={showAddItem}
        onOpenChange={(open) => {
          setShowAddItem(open);
          if (!open) stats.refresh();
        }}
      />

      <QRScanner
        open={showQRScanner}
        onOpenChange={(v) => { setShowQRScanner(v); if (!v) setScanCode(undefined); }}
        initialCode={scanCode}
      />

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />

      <FindMode open={showFind} onOpenChange={setShowFind} />

      <HowItWorks open={showHelp} onOpenChange={setShowHelp} />

      {showOnboarding && <Onboarding onFinish={finishOnboarding} />}
    </div>
  );
};

/** Header button that jumps to Sort Mode, with a live badge counting outstanding org suggestions. */
function SortNavButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => { haptic.light(); onClick(); }}
      title={count > 0 ? `${count} organization suggestion${count > 1 ? "s" : ""}` : "Sort Mode"}
      className="relative text-tile-foreground/70 hover:bg-tile-foreground/10 hover:text-tile-foreground"
    >
      <Sparkles className="h-4 w-4" />
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold leading-4 text-center">
          {count > 99 ? "99+" : count}
        </span>
      )}
      <span className="sr-only">Sort Mode</span>
    </Button>
  );
}

function MobileTab(props: {
  active: boolean;
  onClick: () => void;
  icon: typeof Package;
  label: string;
}) {
  const Icon = props.icon;
  return (
    <button
      onClick={() => { haptic.light(); props.onClick(); }}
      aria-current={props.active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-0.5 py-2 transition-[color,opacity] active:opacity-60",
        props.active ? "text-primary" : "text-tile-foreground/60"
      )}
    >
      <Icon className="h-5 w-5" aria-hidden />
      <span className="font-display text-[11px] font-medium tracking-tight">
        {props.label}
      </span>
    </button>
  );
}

function Overview(props: {
  stats: ReturnType<typeof useInventoryStats>;
  onAddTool: () => void;
}) {
  const { itemCount, locationCount, categoryCounts, totalValue, loading } = props.stats;
  const categories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);

  if (loading) {
    return (
      <div className="p-10 flex justify-center">
        <Package className="h-8 w-8 animate-pulse text-muted-foreground" aria-hidden />
      </div>
    );
  }

  if (itemCount === 0) {
    return (
      <div className="p-8 md:p-12 text-center">
        <div className="label-tile inline-flex items-center px-4 py-2 text-sm mb-4">
          Empty wall
        </div>
        <h2 className="font-display text-2xl font-semibold mb-2">
          Nothing on the board yet
        </h2>
        <p className="text-muted-foreground max-w-sm mx-auto mb-6">
          Add your first tool, or open Storage and map a pegboard, drawer, or shelf
          with the camera.
        </p>
        <Button onClick={props.onAddTool}>
          <Plus className="h-4 w-4 mr-2" />
          Add tool
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <div className="grid grid-cols-3 gap-3 mb-6">
        <BoardStat label="Tools" value={String(itemCount)} />
        <BoardStat label="Locations" value={String(locationCount)} />
        <BoardStat
          label="Value"
          value={totalValue > 0 ? `$${totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
        />
      </div>

      <h2 className="font-display text-lg font-semibold mb-3">
        By category
      </h2>
      <ul className="space-y-2">
        {categories.map(([name, count]) => (
          <li key={name} className="flex items-center gap-3">
            <span className="label-tile px-2.5 py-1 text-xs shrink-0 w-36 text-center truncate">{name}</span>
            <span className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden" aria-hidden>
              <span
                className="block h-full bg-primary/80 rounded-full"
                style={{ width: `${Math.max(4, (count / itemCount) * 100)}%` }}
              />
            </span>
            <span className="font-mono text-sm text-muted-foreground shrink-0 w-8 text-right">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BoardStat(props: { label: string; value: string }) {
  return (
    <div className="label-tile px-3 py-3 text-center">
      <div className="font-display text-2xl md:text-3xl font-bold leading-none">{props.value}</div>
      <div className="font-mono text-[10px] md:text-xs text-tile-foreground/60 mt-1 lowercase">
        {props.label}
      </div>
    </div>
  );
}

/** One tile in the Home quick-access grid: an icon, a label, and an optional count badge. */
function QuickTile(props: {
  icon: typeof Package;
  label: string;
  onClick: () => void;
  badge?: number;
  accent?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      onClick={() => { haptic.light(); props.onClick(); }}
      className="relative flex flex-col items-start gap-2.5 rounded-xl border bg-card p-4 text-left shadow-soft transition active:scale-[0.98] hover:border-primary/40"
    >
      <span className={cn(
        "flex h-11 w-11 items-center justify-center rounded-lg",
        props.accent ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"
      )}>
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="font-display text-sm font-semibold leading-tight">{props.label}</span>
      {props.badge ? (
        <span className="absolute right-3 top-3 min-w-[20px] rounded-full bg-primary px-1.5 text-center text-[11px] font-bold leading-5 text-primary-foreground">
          {props.badge > 99 ? "99+" : props.badge}
        </span>
      ) : null}
    </button>
  );
}

/** Home / dashboard: the app's landing page — key stats, an organization nudge, and a 2-column grid
 *  of quick-access tiles to every page and tool. */
function HomeDashboard(props: {
  stats: ReturnType<typeof useInventoryStats>;
  sortCount: number;
  onNavigate: (t: Tab) => void;
  onAddTool: () => void;
  onScan: () => void;
  onMapSpace: () => void;
  onSettings: () => void;
  onHelp: () => void;
}) {
  const { itemCount, locationCount, totalValue } = props.stats;
  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* At-a-glance stats */}
      <div className="grid grid-cols-3 gap-3">
        <BoardStat label="Tools" value={String(itemCount)} />
        <BoardStat label="Locations" value={String(locationCount)} />
        <BoardStat
          label="Value"
          value={totalValue > 0 ? `$${totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
        />
      </div>

      {/* Organization nudge */}
      {props.sortCount > 0 && (
        <button
          onClick={() => { haptic.light(); props.onNavigate("sort"); }}
          className="flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3.5 text-left transition active:scale-[0.99]"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <Sparkles className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium leading-tight">{props.sortCount} thing{props.sortCount > 1 ? "s" : ""} to organize</div>
            <div className="text-sm text-muted-foreground">Open Sort Mode to tidy up</div>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      )}

      {/* Quick access to every page + tool */}
      <div>
        <h2 className="mb-3 font-display text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quick access</h2>
        <div className="grid grid-cols-2 gap-3">
          <QuickTile icon={Plus} label="Add tool" accent onClick={props.onAddTool} />
          <QuickTile icon={ScanLine} label="Scan a label" onClick={props.onScan} />
          <QuickTile icon={Package} label="Tools" onClick={() => props.onNavigate("items")} />
          <QuickTile icon={MapPin} label="Storage" onClick={() => props.onNavigate("locations")} />
          <QuickTile icon={Sparkles} label="Sort Mode" badge={props.sortCount || undefined} onClick={() => props.onNavigate("sort")} />
          <QuickTile icon={LayoutGrid} label="Overview" onClick={() => props.onNavigate("overview")} />
          <QuickTile icon={Wrench} label="Map a space" onClick={props.onMapSpace} />
          <QuickTile icon={Settings} label="Settings" onClick={props.onSettings} />
          <QuickTile icon={HelpCircle} label="How it works" onClick={props.onHelp} />
        </div>
      </div>
    </div>
  );
}

export default Index;
