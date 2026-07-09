import { useMemo, useState } from "react";
import { Sparkles, Grid3x3, Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { buildSlotDefs, createSpaceWithSlots } from "@/lib/slots";
import { BUILTIN_TEMPLATES, type LabelData } from "@/lib/labelTemplates";
import { getAllTemplates, resolveTemplate } from "@/lib/customTemplates";
import { LabelTemplateRenderer } from "./LabelTemplateRenderer";
import { suggestSpaceFromImage, isVisionConfigured, VisionNotConfiguredError } from "@/lib/vision";

const SPACE_TYPES = ["pegboard", "drawer", "shelf", "bin", "cabinet", "rack", "board", "wall", "space"];

const NAMING_PRESETS = [
  { label: "Name + coords (Pegboard R2C3)", value: "{{parent}} {{slot}}" },
  { label: "Padded (Pegboard-02-03)", value: "{{parent}}-{{row}}-{{col}}" },
  { label: "Sequential (Pegboard #012)", value: "{{parent}} #{{index}}" },
  { label: "Coords only (R2C3)", value: "{{slot}}" },
];

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: () => void;
}

export function MapSpaceDialog({ open, onOpenChange, onCreated }: Props) {
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [type, setType] = useState("pegboard");
  const [description, setDescription] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [gridRows, setGridRows] = useState(4);
  const [gridCols, setGridCols] = useState(5);
  const [namingScheme, setNamingScheme] = useState(NAMING_PRESETS[0].value);
  const [pad, setPad] = useState(true);
  const [templateId, setTemplateId] = useState(BUILTIN_TEMPLATES[0].id);
  const [aiBusy, setAiBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const reset = () => {
    setStep(1); setName(""); setType("pegboard"); setDescription(""); setImageDataUrl(null);
    setGridRows(4); setGridCols(5); setNamingScheme(NAMING_PRESETS[0].value); setPad(true);
    setTemplateId(BUILTIN_TEMPLATES[0].id);
  };

  const close = (v: boolean) => { if (!v) reset(); onOpenChange(v); };

  const slotDefs = useMemo(
    () => buildSlotDefs({ rows: gridRows, cols: gridCols, namingScheme, parentName: name || "Space", pad }),
    [gridRows, gridCols, namingScheme, name, pad],
  );

  const previewData: LabelData = useMemo(() => {
    const d = slotDefs[0];
    return {
      name: d?.name ?? name,
      parent: name || "Space",
      type,
      slot: "R1C1",
      row: pad ? "01" : "1",
      col: pad ? "01" : "1",
      index: pad ? "001" : "1",
      qr: d?.qr_code ?? "LOC-PREVIEW",
    };
  }, [slotDefs, name, type, pad]);

  const onPickPhoto = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(String(reader.result));
    reader.readAsDataURL(file);
  };

  const runAISuggest = async () => {
    if (!imageDataUrl) return;
    setAiBusy(true);
    try {
      const s = await suggestSpaceFromImage(imageDataUrl, type);
      if (s.gridRows) setGridRows(s.gridRows);
      if (s.gridCols) setGridCols(s.gridCols);
      if (s.type) setType(s.type);
      toast({
        title: "AI mapped the space",
        description: `Suggested a ${s.gridRows ?? gridRows}x${s.gridCols ?? gridCols} grid${s.notes ? ` — ${s.notes}` : ""}. Adjust as needed.`,
      });
      setStep(2);
    } catch (e) {
      if (e instanceof VisionNotConfiguredError) {
        toast({
          title: "AI not connected yet",
          description: "Set up the vision service on your Mac mini to auto-map spaces. For now, enter the grid manually.",
        });
        setStep(2);
      } else {
        toast({ title: "Couldn't analyze photo", description: String((e as Error)?.message || e), variant: "destructive" });
      }
    } finally {
      setAiBusy(false);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      const { slots } = await createSpaceWithSlots({
        name, type, description, gridRows, gridCols, imagePath: imageDataUrl, namingScheme, labelTemplateId: templateId, pad,
      });
      toast({ title: "Space mapped", description: `Created "${name}" with ${slots.length} slots.` });
      onCreated?.();
      close(false);
    } catch (e) {
      toast({ title: "Failed to create space", description: String((e as Error)?.message || e), variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const capCells = 60; // cap the rendered grid preview for very large spaces

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Grid3x3 className="h-5 w-5" /> Map a Space — step {step} of 3
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="space-name">Space name *</Label>
              <Input id="space-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g., East Wall Pegboard" />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SPACE_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Photo of the space (optional — lets AI propose the grid)</Label>
              <div className="flex items-center gap-3">
                <Button type="button" variant="outline" asChild>
                  <label className="cursor-pointer">
                    <Camera className="h-4 w-4 mr-2" /> Choose photo
                    <input type="file" accept="image/*" className="hidden"
                      onChange={(e) => onPickPhoto(e.target.files?.[0])} />
                  </label>
                </Button>
                {imageDataUrl && <img src={imageDataUrl} alt="space" className="h-16 w-16 rounded object-cover border" />}
              </div>
              {!isVisionConfigured() && (
                <p className="text-xs text-muted-foreground">
                  AI mapping runs on your self-hosted vision service. Until it's set up you can map spaces manually.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="space-desc">Description (optional)</Label>
              <Textarea id="space-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rows">Rows</Label>
                <Input id="rows" type="number" min={1} max={40} value={gridRows}
                  onChange={(e) => setGridRows(Math.max(1, Math.min(40, parseInt(e.target.value) || 1)))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cols">Columns</Label>
                <Input id="cols" type="number" min={1} max={40} value={gridCols}
                  onChange={(e) => setGridCols(Math.max(1, Math.min(40, parseInt(e.target.value) || 1)))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Slot naming</Label>
              <Select value={NAMING_PRESETS.some((p) => p.value === namingScheme) ? namingScheme : "custom"}
                onValueChange={(v) => v !== "custom" && setNamingScheme(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {NAMING_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
              <Input value={namingScheme} onChange={(e) => setNamingScheme(e.target.value)}
                placeholder="Tokens: {{parent}} {{row}} {{col}} {{index}} {{slot}}" className="font-mono text-xs" />
              <div className="flex items-center gap-2 pt-1">
                <Switch id="pad" checked={pad} onCheckedChange={setPad} />
                <Label htmlFor="pad" className="text-sm font-normal">Zero-pad numbers (01, 02…)</Label>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Preview — {gridRows * gridCols} slots</Label>
              <div className="grid gap-1 rounded-md border p-2 bg-muted/30"
                style={{ gridTemplateColumns: `repeat(${Math.min(gridCols, 8)}, minmax(0, 1fr))` }}>
                {slotDefs.slice(0, capCells).map((d) => (
                  <div key={d.slot_index} className="text-[10px] leading-tight bg-background rounded px-1 py-1 border truncate" title={d.name}>
                    {d.name}
                  </div>
                ))}
              </div>
              {slotDefs.length > capCells && (
                <p className="text-xs text-muted-foreground">…and {slotDefs.length - capCells} more.</p>
              )}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Label template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {getAllTemplates().map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{resolveTemplate(templateId).description}</p>
            </div>
            <div className="space-y-2">
              <Label>Sample slot label</Label>
              <div className="flex justify-center rounded-md border p-4 bg-muted/30">
                <LabelTemplateRenderer template={resolveTemplate(templateId)} data={previewData} pxPerMm={5} />
              </div>
            </div>
            <div className="rounded-md border p-3 text-sm text-muted-foreground">
              Creating <span className="font-medium text-foreground">{name || "(unnamed)"}</span> as a{" "}
              <span className="font-medium text-foreground">{gridRows}×{gridCols}</span> {type} —{" "}
              <span className="font-medium text-foreground">{gridRows * gridCols} slots</span>, each with its own QR label.
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step > 1 && <Button variant="outline" onClick={() => setStep(step - 1)} disabled={creating || aiBusy}>Back</Button>}
          {step === 1 && (
            <>
              {imageDataUrl && (
                <Button variant="secondary" onClick={runAISuggest} disabled={aiBusy}>
                  {aiBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                  Map with AI
                </Button>
              )}
              <Button onClick={() => setStep(2)} disabled={!name.trim()}>Next</Button>
            </>
          )}
          {step === 2 && <Button onClick={() => setStep(3)} disabled={gridRows < 1 || gridCols < 1}>Next</Button>}
          {step === 3 && (
            <Button onClick={create} disabled={creating || !name.trim()}>
              {creating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Grid3x3 className="h-4 w-4 mr-2" />}
              Create {gridRows * gridCols} slots
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
