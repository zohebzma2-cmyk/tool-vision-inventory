import { useCallback, useEffect, useState } from "react";
import { ArrowRight, PackageOpen, MapPin, AlertTriangle, Sparkles, RefreshCw, Loader2, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/adaptive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { computeOrgReport, dismissSuggestion, type OrgReport, type OrgSuggestion } from "@/lib/organize";
import { haptic } from "@/lib/haptics";
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
  // "Assign a spot" for a homeless item: which suggestion is being assigned + the chosen location.
  const [assignFor, setAssignFor] = useState<OrgSuggestion | null>(null);
  const [assignLoc, setAssignLoc] = useState("");
  const [assignLocations, setAssignLocations] = useState<{ id: string; name: string; type: string }[]>([]);

  useEffect(() => {
    if (!assignFor) return;
    setAssignLoc("");
    supabase.from("locations").select("id,name,type").eq("is_slot", false).order("name")
      .then(({ data }) => setAssignLocations(data ?? []));
  }, [assignFor]);

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
      // Carry the item's existing quantity to the new bin — don't silently collapse a qty>1 to 1.
      const { data: cur } = await supabase
        .from("item_locations")
        .select("quantity")
        .eq("item_id", s.itemId).eq("location_id", s.locationId).is("date_removed", null)
        .order("date_placed", { ascending: false }).limit(1).maybeSingle();
      const qty = cur?.quantity ?? 1;
      const { error: rmErr } = await supabase
        .from("item_locations")
        .update({ date_removed: new Date().toISOString() })
        .eq("item_id", s.itemId).eq("location_id", s.locationId).is("date_removed", null);
      if (rmErr) throw rmErr;
      const { error: addErr } = await supabase
        .from("item_locations")
        .insert({ item_id: s.itemId, location_id: s.suggestedLocationId, quantity: qty });
      if (addErr) throw addErr;
      haptic.success();
      toast({ title: "Moved", description: `Now in ${s.suggestedLocationName}.` });
      await load();
    } catch (e) {
      toast({ title: "Move failed", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  function dismiss(s: OrgSuggestion) {
    haptic.light();
    dismissSuggestion(s);
    // Drop it from view immediately AND keep the count chips + summary in sync (it won't come back
    // until its weekly snooze expires).
    setReport((r) => {
      if (!r) return r;
      const suggestions = r.suggestions.filter((x) => x !== s);
      const counts = {
        overfull: suggestions.filter((x) => x.kind === "overfull").length,
        misplaced: suggestions.filter((x) => x.kind === "misplaced").length,
        homeless: suggestions.filter((x) => x.kind === "homeless").length,
      };
      const parts: string[] = [];
      if (counts.overfull) parts.push(`${counts.overfull} space${counts.overfull > 1 ? "s" : ""} filling up`);
      if (counts.misplaced) parts.push(`${counts.misplaced} item${counts.misplaced > 1 ? "s" : ""} out of place`);
      if (counts.homeless) parts.push(`${counts.homeless} item${counts.homeless > 1 ? "s" : ""} with no home`);
      const summary = parts.length ? `Found ${parts.join(", ")}.` : "Everything looks well organized — nothing to sort right now.";
      return { ...r, suggestions, counts, summary };
    });
  }

  async function assignItem() {
    if (!assignFor?.itemId || !assignLoc) return;
    setBusyId("assign");
    try {
      // Place the whole item (its full quantity) into the chosen location — gives a homeless item a home.
      const { data: item } = await supabase.from("items").select("quantity").eq("id", assignFor.itemId).maybeSingle();
      const { error } = await supabase.from("item_locations")
        .insert({ item_id: assignFor.itemId, location_id: assignLoc, quantity: item?.quantity ?? 1 });
      if (error) throw error;
      haptic.success();
      const locName = assignLocations.find((l) => l.id === assignLoc)?.name;
      toast({ title: "Assigned", description: locName ? `Now in ${locName}.` : "Item now has a home." });
      setAssignFor(null);
      await load();
    } catch (e) {
      toast({ title: "Assign failed", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
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
                <div className="flex shrink-0 items-center gap-1">
                  {canMove && (
                    <Button
                      size="sm"
                      variant="secondary"
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
                  {s.kind === "homeless" && (
                    <Button size="sm" variant="secondary" onClick={() => setAssignFor(s)}>
                      Assign <MapPin className="ml-1 h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground"
                    onClick={() => dismiss(s)} aria-label="Dismiss suggestion">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Assign-a-spot picker for a homeless item. */}
      <Dialog open={!!assignFor} onOpenChange={(o) => { if (!o) setAssignFor(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Assign a spot</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Choose where <span className="font-medium text-foreground">{assignFor?.title?.replace(/ has no home$/, "")}</span> belongs.
            </p>
            <Select value={assignLoc} onValueChange={setAssignLoc}>
              <SelectTrigger><SelectValue placeholder="Pick a bin or location" /></SelectTrigger>
              <SelectContent>
                {assignLocations.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">No locations yet — create one first.</div>
                ) : assignLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name}{l.type ? ` · ${l.type}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAssignFor(null)}>Cancel</Button>
            <Button onClick={assignItem} disabled={!assignLoc || busyId === "assign"}>
              {busyId === "assign" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
