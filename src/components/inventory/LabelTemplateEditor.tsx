import { useMemo, useState } from "react";
import { Tags, Save, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/adaptive-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cloneTemplate, type LabelTemplate, type LabelData, type LabelElement } from "@/lib/labelTemplates";
import { getAllTemplates, saveCustomTemplate, deleteCustomTemplate, isCustomId } from "@/lib/customTemplates";
import { LabelTemplateRenderer } from "./LabelTemplateRenderer";

const SAMPLE: LabelData = {
  name: "Impact Driver", parent: "East Wall Pegboard", type: "pegboard",
  slot: "R2C3", row: "02", col: "03", index: "013", brand: "Makita", model: "XDT13",
  qr: "LOC-SAMPLE-AB12C",
};

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function LabelTemplateEditor({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const [baseId, setBaseId] = useState<string>("");
  const [draft, setDraft] = useState<LabelTemplate | null>(null);

  const templates = useMemo(() => (open ? getAllTemplates() : []), [open]);

  const startFrom = (id: string) => {
    const src = getAllTemplates().find((t) => t.id === id);
    if (!src) return;
    setBaseId(id);
    const copy = cloneTemplate(src);
    // If editing a built-in, fork to a new custom id; if editing a custom, keep its id.
    if (!isCustomId(id)) {
      // Unique per fork — a content-derived id collides when you customize the same built-in twice,
      // silently overwriting the earlier custom template.
      copy.id = `custom-${id}-${Date.now().toString(36)}`;
      copy.name = `${src.name} (custom)`;
    }
    setDraft(copy);
  };

  const patchEl = (elId: string, patch: Partial<LabelElement>) => {
    setDraft((d) => d ? { ...d, elements: d.elements.map((e) => (e.id === elId ? { ...e, ...patch } : e)) } : d);
  };

  const save = () => {
    if (!draft) return;
    if (!draft.name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
    saveCustomTemplate(draft);
    toast({ title: "Template saved", description: `"${draft.name}" is now available when labeling.` });
    setDraft(null); setBaseId("");
  };

  const remove = () => {
    if (!draft) return;
    deleteCustomTemplate(draft.id);
    toast({ title: "Template deleted", description: draft.name });
    setDraft(null); setBaseId("");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setDraft(null); setBaseId(""); } onOpenChange(v); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Tags className="h-5 w-5" /> Label templates</DialogTitle>
        </DialogHeader>

        {!draft ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Pick a template to customize, or start from a built-in. Your saved templates appear when mapping spaces and printing.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {templates.map((t) => (
                <button key={t.id} onClick={() => startFrom(t.id)}
                  className="text-left rounded-md border p-3 hover:bg-muted transition-colors flex items-center gap-3">
                  <LabelTemplateRenderer template={t} data={SAMPLE} pxPerMm={2.5} />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{t.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{t.widthMm}×{t.heightMm || "auto"}mm{isCustomId(t.id) ? " · custom" : ""}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-center rounded-md border p-4 bg-muted/30">
              <LabelTemplateRenderer template={draft} data={SAMPLE} pxPerMm={5} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Template name</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label>Width mm</Label>
                  <Input type="number" value={draft.widthMm} onChange={(e) => setDraft({ ...draft, widthMm: Number(e.target.value) || 62 })} />
                </div>
                <div className="space-y-1">
                  <Label>Height mm</Label>
                  <Input type="number" value={draft.heightMm} onChange={(e) => setDraft({ ...draft, heightMm: Number(e.target.value) || 0 })} />
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <Label className="text-sm">Fields</Label>
              {draft.elements.map((el) => (
                <div key={el.id} className="rounded-md border p-3 space-y-2">
                  <div className="text-xs font-medium uppercase text-muted-foreground">{el.type === "qr" ? "QR code" : "Text"}</div>
                  {el.type === "text" && (
                    <>
                      <Input value={el.value ?? ""} onChange={(e) => patchEl(el.id, { value: e.target.value })}
                        placeholder="Tokens: {{name}} {{parent}} {{slot}} {{brand}} {{model}}" className="font-mono text-xs" />
                      <div className="flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-2">
                          <Switch checked={!!el.bold} onCheckedChange={(v) => patchEl(el.id, { bold: v })} />
                          <span className="text-sm">Bold</span>
                        </div>
                        <Select value={el.align ?? "left"} onValueChange={(v) => patchEl(el.id, { align: v as LabelElement["align"] })}>
                          <SelectTrigger className="w-28 h-8"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="left">Left</SelectItem>
                            <SelectItem value="center">Center</SelectItem>
                            <SelectItem value="right">Right</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select value={el.color ?? "black"} onValueChange={(v) => patchEl(el.id, { color: v as LabelElement["color"] })}>
                          <SelectTrigger className="w-28 h-8"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="black">Black</SelectItem>
                            <SelectItem value="red">Red</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-2 flex-1 min-w-[140px]">
                          <span className="text-xs text-muted-foreground">Size</span>
                          <Slider min={0.5} max={2} step={0.1} value={[el.fontScale ?? 1]}
                            onValueChange={([v]) => patchEl(el.id, { fontScale: v })} />
                        </div>
                      </div>
                    </>
                  )}
                  {el.type === "qr" && <p className="text-xs text-muted-foreground">Encodes the slot's QR code. Position/size are fixed by this template.</p>}
                </div>
              ))}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => { setDraft(null); setBaseId(""); }}>Back</Button>
              {isCustomId(draft.id) && <Button variant="ghost" onClick={remove} className="text-destructive"><Trash2 className="h-4 w-4 mr-2" />Delete</Button>}
              <Button onClick={save}><Save className="h-4 w-4 mr-2" />Save template</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
