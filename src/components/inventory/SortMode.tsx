import { useCallback, useEffect, useState } from "react";
import { ArrowRight, PackageOpen, MapPin, AlertTriangle, Sparkles, RefreshCw, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { computeOrgReport, type OrgReport, type OrgSuggestion } from "@/lib/organize";
import { cn } from "@/lib/utils";

const SEV: Record<OrgSuggestion["severity"], { ring: string; text: string; dot: string }> = {
  urgent: { ring: "border-red-500/40", text: "text-red-600 dark:text-red-400", dot: "bg-red-500" },
  warning: { ring: "border-amber-500/40", text: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
  info: { ring: "border-sky-500/30", text: "text-sky-600 dark:text-sky-400", dot: "bg-sky-500" },
};

const KIND_ICON = { overfull: AlertTriangle, misplaced: PackageOpen, homeless: MapPin } as const;

export function SortMode({ syncSignal }: { syncSignal?: number }) {
  const { toast } = useToast();
  const [report, setReport] = useState<OrgReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await computeOrgReport());
    } catch (e) {
      toast({ title: "Couldn't analyze", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load, syncSignal]);

  async function moveItem(s: OrgSuggestion) {
    if (!s.itemId || !s.locationId || !s.suggestedLocationId) return;
    setBusyId(s.itemId + s.locationId);
    try {
      const { error: rmErr } = await supabase
        .from("item_locations")
        .update({ date_removed: new Date().toISOString() })
        .eq("item_id", s.itemId).eq("location_id", s.locationId).is("date_removed", null);
      if (rmErr) throw rmErr;
      const { error: addErr } = await supabase
        .from("item_locations")
        .insert({ item_id: s.itemId, location_id: s.suggestedLocationId, quantity: 1 });
      if (addErr) throw addErr;
      toast({ title: "Moved", description: `Now in ${s.suggestedLocationName}.` });
      await load();
    } catch (e) {
      toast({ title: "Move failed", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  if (loading && !report) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Analyzing your organization…
      </div>
    );
  }
  if (!report) return null;

  const { suggestions, fullness, summary, counts } = report;
  const clear = suggestions.length === 0;

  return (
    <div className="space-y-4">
      {/* Header / summary */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-xl bg-primary/10 p-2 text-primary"><Sparkles className="h-5 w-5" /></div>
          <div>
            <h2 className="text-lg font-semibold leading-tight">Sort Mode</h2>
            <p className="text-sm text-muted-foreground">{summary}</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={loading} aria-label="Re-analyze">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      {/* Count chips */}
      {!clear && (
        <div className="flex flex-wrap gap-2">
          {counts.overfull > 0 && <Badge variant="outline" className={SEV.warning.text}>{counts.overfull} filling up</Badge>}
          {counts.misplaced > 0 && <Badge variant="outline" className={SEV.info.text}>{counts.misplaced} out of place</Badge>}
          {counts.homeless > 0 && <Badge variant="outline" className={SEV.info.text}>{counts.homeless} no home</Badge>}
        </div>
      )}

      {/* Fullness bars */}
      {fullness.length > 0 && (
        <Card className="p-4 space-y-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Space fullness</div>
          {fullness.slice(0, 8).map((f) => {
            const pct = Math.min(100, Math.round(f.ratio * 100));
            const tone = f.ratio >= 1 ? "bg-red-500" : f.ratio >= 0.8 ? "bg-amber-500" : "bg-emerald-500";
            return (
              <div key={f.locationId} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate">{f.name}</span>
                  <span className="tabular-nums text-muted-foreground">{f.used}/{f.cap}</span>
                </div>
                <Progress value={pct} indicatorClassName={tone} className="h-2" />
              </div>
            );
          })}
        </Card>
      )}

      {/* Suggestions */}
      {clear ? (
        <Card className="p-8 text-center text-muted-foreground">
          <Sparkles className="mx-auto mb-2 h-6 w-6 text-emerald-500" />
          <div className="font-medium text-foreground">All organized</div>
          <div className="text-sm">No spaces overflowing and nothing out of place.</div>
        </Card>
      ) : (
        <div className="space-y-2">
          {suggestions.map((s, i) => {
            const Icon = KIND_ICON[s.kind];
            const sev = SEV[s.severity];
            const canMove = s.kind === "misplaced" && s.suggestedLocationId;
            const key = (s.itemId ?? "") + (s.locationId ?? "") + i;
            return (
              <Card key={key} className={cn("flex items-start gap-3 border-l-4 p-3", sev.ring)}>
                <div className={cn("mt-0.5 rounded-lg p-1.5", sev.text)}><Icon className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium leading-tight">{s.title}</div>
                  <div className="text-sm text-muted-foreground">{s.detail}</div>
                </div>
                {canMove && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    disabled={busyId === s.itemId! + s.locationId!}
                    onClick={() => moveItem(s)}
                  >
                    {busyId === s.itemId! + s.locationId! ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>Move <ArrowRight className="ml-1 h-3.5 w-3.5" /></>
                    )}
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
