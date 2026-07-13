import { useEffect, useState } from "react";
import { Plus, Package, MapPin, LayoutGrid, ScanLine, Settings, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { AddItemDialog } from "@/components/inventory/AddItemDialog";
import { ItemsList } from "@/components/inventory/ItemsList";
import { LocationsList } from "@/components/inventory/LocationsList";
import { QRScanner } from "@/components/inventory/QRScanner";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useInventoryStats } from "@/hooks/useInventoryStats";
import { useRealtimeSync } from "@/hooks/useRealtimeSync";
import { cn } from "@/lib/utils";
import { haptic } from "@/lib/haptics";

type Tab = "items" | "locations" | "overview";

const Index = () => {
  const [showAddItem, setShowAddItem] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [tab, setTab] = useState<Tab>("items");
  const [openMapOnLocations, setOpenMapOnLocations] = useState(false);
  const { user } = useAuth();
  const stats = useInventoryStats();

  // Live sync across every signed-in device (desktop <-> phone), instant.
  const [syncTick, setSyncTick] = useState(0);
  useRealtimeSync(["items", "locations", "item_locations"], () => {
    stats.refresh();
    setSyncTick((t) => t + 1);
  });

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
                <h1 className="font-display text-2xl md:text-3xl font-bold uppercase tracking-[0.08em] leading-none truncate">
                  Tool Vision
                </h1>
                <p className="font-mono text-[11px] md:text-xs text-tile-foreground/60 mt-1 truncate">
                  {stats.loading
                    ? "reading the wall…"
                    : [
                        `${stats.itemCount} tools`,
                        `${stats.locationCount} spaces`,
                        ...(stats.totalValue > 0 ? [`${fmtMoney(stats.totalValue)} on the wall`] : []),
                      ].join(" · ")}
                </p>
              </div>
            </div>

            {/* Desktop actions */}
            <div className="hidden md:flex items-center gap-2">
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

            {/* Mobile: settings only — actions live in the bottom bar */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSettings(true)}
              title="Settings"
              className="md:hidden text-tile-foreground/70 hover:bg-tile-foreground/10 hover:text-tile-foreground"
            >
              <Settings className="h-4 w-4" />
              <span className="sr-only">Settings</span>
            </Button>
          </div>

          {/* Desktop tab rail */}
          <nav className="hidden md:flex gap-1 mt-4 -mb-px" aria-label="Sections">
            {(
              [
                { id: "items", label: "Tools", icon: Package },
                { id: "locations", label: "Spaces", icon: MapPin },
                { id: "overview", label: "Overview", icon: LayoutGrid },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                aria-current={tab === id ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 font-display uppercase tracking-[0.08em] text-sm font-semibold rounded-t border-b-2 transition-colors",
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
        <div className="bg-card rounded-lg shadow-soft border">
          {tab === "items" && (
            <ItemsList key={`items-${syncTick}`} />
          )}
          {tab === "locations" && (
            <LocationsList
              key={`locs-${syncTick}`}
              openMapOnMount={openMapOnLocations}
              onMapOpened={() => setOpenMapOnLocations(false)}
            />
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
            label="Spaces"
          />
          <button
            onClick={() => { haptic.medium(); setShowAddItem(true); }}
            className="flex flex-col items-center justify-center gap-0.5 py-2 active:opacity-60"
            aria-label="Add tool"
          >
            <span className="flex items-center justify-center h-9 w-9 rounded bg-primary text-primary-foreground shadow-soft">
              <Plus className="h-5 w-5" aria-hidden />
            </span>
            <span className="font-display uppercase tracking-[0.08em] text-[10px] font-semibold">
              Add
            </span>
          </button>
          <MobileTab
            active={false}
            onClick={() => setShowQRScanner(true)}
            icon={ScanLine}
            label="Scan"
          />
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

      <QRScanner open={showQRScanner} onOpenChange={setShowQRScanner} />

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />

      {showOnboarding && <Onboarding onFinish={finishOnboarding} />}
    </div>
  );
};

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
      <span className="font-display uppercase tracking-[0.08em] text-[10px] font-semibold">
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
        <h2 className="font-display text-2xl font-semibold uppercase tracking-wide mb-2">
          Nothing on the board yet
        </h2>
        <p className="text-muted-foreground max-w-sm mx-auto mb-6">
          Add your first tool, or open Spaces and map a pegboard, drawer, or shelf
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
        <BoardStat label="Spaces" value={String(locationCount)} />
        <BoardStat
          label="Value"
          value={totalValue > 0 ? `$${totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
        />
      </div>

      <h2 className="font-display text-lg font-semibold uppercase tracking-wide mb-3">
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

export default Index;
