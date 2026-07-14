import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/adaptive-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ImageRecognition } from "./ImageRecognition";
import { isPrintingSupported, autoPrintLabel, printTextLabel } from "./PrinterService";
import { LabelPreview } from "./LabelPreview";
import { useCategories } from "@/hooks/useCategories";

interface AddItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddItemDialog({ open, onOpenChange }: AddItemDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    category: "",
    brand: "",
    model: "",
    size_specs: "",
    quantity: 1,
    quantity_unit: "piece",
    purchase_date: "",
    purchase_price: "",
    notes: ""
  });
  
  const [aiPlacement, setAiPlacement] = useState<string | null>(null);
  const [previewItemQr, setPreviewItemQr] = useState<string | null>(null);
  const [previewLocation, setPreviewLocation] = useState<any | null>(null);
  
  const { toast } = useToast();

  const [dims, setDims] = useState({ length: '', width: '', height: '' });
  const [manualLocationId, setManualLocationId] = useState<string>('');
  const [locations, setLocations] = useState<any[]>([]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const { data } = await supabase.from('locations').select('*').order('name');
      setLocations(data || []);
    })();
  }, [open]);

  const { categories, addCategory } = useCategories();

  const handleToolIdentified = (toolInfo: { name: string; category: string; confidence: number }) => {
    setFormData(prev => ({
      ...prev,
      name: toolInfo.name,
      category: mapCategoryToFormCategory(toolInfo.category),
      description: `Identified tool: ${toolInfo.name} (${Math.round(toolInfo.confidence * 100)}% confidence)`
    }));
  };

  const handleTextExtracted = (text: string) => {
    setFormData(prev => ({
      ...prev,
      notes: prev.notes ? `${prev.notes}\n\nExtracted text: ${text}` : `Extracted text: ${text}`
    }));
  };

  const mapCategoryToFormCategory = (aiCategory: string): string => {
    const categoryMap: Record<string, string> = {
      'hand tools': 'Hand Tools',
      'power tools': 'Power Tools',
      'cutting tools': 'Cutting Tools',
      'measuring tools': 'Measuring Tools',
      'fasteners': 'Fasteners',
      'equipment': 'Hardware',
      'machinery': 'Power Tools',
      'general tools': 'Hand Tools',
      'miscellaneous': 'Other',
      'electrical': 'Electrical',
      'plumbing': 'Plumbing',
      'other': 'Other'
    };
    return categoryMap[aiCategory] || 'Other';
  };

  const generateItemQrCode = () => `ITEM-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

  const normalizeDate = (v: string): string | null => {
    if (!v) return null;
    // ISO yyyy-mm-dd
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      const [_, y, m, d] = iso;
      const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
      if (!isNaN(dt.getTime())) return `${y}-${m}-${d}`;
      return null;
    }
    // Try mm/dd/yyyy or mm-dd-yyyy
    const mdy = v.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
    if (mdy) {
      let [_, mm, dd, yy] = mdy;
      if (yy.length === 2) yy = String(2000 + Number(yy));
      const m = String(Number(mm)).padStart(2, '0');
      const d = String(Number(dd)).padStart(2, '0');
      const dt = new Date(`${yy}-${m}-${d}T00:00:00Z`);
      if (!isNaN(dt.getTime())) return `${yy}-${m}-${d}`;
    }
    return null;
  };
  const handleAutoFill = (fields: any) => {
    setFormData(prev => ({
      ...prev,
      ...fields,
      category: fields?.category ? mapCategoryToFormCategory(String(fields.category).toLowerCase()) : prev.category,
    }));
  };
  const handlePreviewLabels = async () => {
    try {
      const finalCategory = formData.category || 'Other';
      if (!previewItemQr) setPreviewItemQr(generateItemQrCode());

      const norm = (s?: string) => (s || '').toLowerCase();
      const text = `${formData.name} ${formData.description} ${formData.notes}`.toLowerCase();
      const categoryKey = norm(finalCategory);

      const { data: locations, error: locErr } = await supabase
        .from('locations')
        .select('*');
      if (locErr || !locations?.length) {
        toast({ title: 'No locations yet', description: 'Create locations to enable previews.', variant: 'destructive' });
        return;
      }

      const { data: occRows } = await supabase
        .from('item_locations')
        .select('location_id')
        .is('date_removed', null);
      const occMap = new Map<string, number>();
      occRows?.forEach((r: any) => {
        const id = (r.location_id as string) || '';
        occMap.set(id, (occMap.get(id) || 0) + 1);
      });

      const hasAny = (arr: string[]) => arr.some(k => text.includes(k));
      const socketKeywords = ['socket','ratchet','torx','1/4"','3/8"','1/2"','hex bit socket','extension'];
      const smallParts = ['screw','bolt','nut','washer','nail','anchor','fastener','o-ring','zip tie','clip','fuse','connector','terminal'];
      const pegKeywords = ['wrench','pliers','screwdriver','hammer','tape measure','square','level','saw','clamp','chisel','mallet'];
      const powerKeywords = ['drill','driver','grinder','sander','router','planer','circular saw','miter','reciprocating saw','jigsaw','multi-tool','dremel'];

      const preferSockets = hasAny(socketKeywords) || /socket/i.test(formData.name);
      const preferBins = hasAny(smallParts) || categoryKey === 'fasteners' || /small|mixed parts/.test(text);
      const preferPeg = hasAny(pegKeywords) || ['hand tools','measuring tools','cutting tools'].includes(categoryKey);
      const preferPower = hasAny(powerKeywords) || categoryKey === 'power tools';

      const isLarge = /large|table|floor|stand|heavy|4x8|4x 8|4\s*x\s*8/i.test(text) ||
        ((formData.size_specs || '').toLowerCase().includes('inch') && /2[5-9]|[3-9]\d/.test(formData.size_specs || ''));

      const fits = (loc: any) => {
        // Never auto-place a tool into a place/space (Garage, Shed…) — only into real storage.
        if (String(loc.type).toLowerCase() === 'space') return false;
        const cap = (loc.capacity as number | null) ?? null;
        const occ = occMap.get(loc.id) || 0;
        return cap === null || occ < cap;
      };
      const byLowestOcc = (a: any, b: any) => ( (occMap.get(a.id) || 0) - (occMap.get(b.id) || 0) );
      const findFirst = (filterFn: (l:any)=>boolean) => locations.filter(filterFn).filter(fits).sort(byLowestOcc)[0];

      let chosen: any | undefined;
      if (!chosen && aiPlacement) {
        const t = norm(aiPlacement);
        if (t === 'sockets-drawer') chosen = findFirst(l => norm(l.type) === 'drawer' && /socket/.test(norm(l.name)));
        else if (t === 'bin') chosen = findFirst(l => norm(l.type) === 'bin');
        else if (t === 'pegboard') chosen = findFirst(l => norm(l.type) === 'pegboard');
        else if (t === 'drawer') chosen = findFirst(l => norm(l.type) === 'drawer' && /4x8|4x 8|4\s*x\s*8/.test(norm(l.name))) || findFirst(l => norm(l.type) === 'drawer');
        else if (t === 'large-area') chosen = findFirst(l => /large.*area/.test(norm(l.name)) || norm(l.type) === 'rack');
        else if (t === 'general-shelf') chosen = findFirst(l => /general/.test(norm(l.name)) || norm(l.type) === 'shelf');
      }
      if (!chosen && preferSockets) chosen = findFirst(l => norm(l.type) === 'drawer' && /socket/.test(norm(l.name))) || findFirst(l => /socket/.test(norm(l.name)));
      if (!chosen && preferBins) chosen = findFirst(l => norm(l.type) === 'bin');
      if (!chosen && preferPeg) chosen = findFirst(l => norm(l.type) === 'pegboard');
      if (!chosen && preferPower) chosen = findFirst(l => norm(l.type) === 'drawer' && /4x8|4x 8|4\s*x\s*8/.test(norm(l.name))) || findFirst(l => norm(l.type) === 'drawer');
      if (!chosen && isLarge) chosen = findFirst(l => /large.*area/.test(norm(l.name)) || /large/.test(norm(l.name)));
      if (!chosen) chosen = findFirst(l => /general/.test(norm(l.name)));
      if (!chosen) chosen = findFirst(() => true);

      if (chosen) setPreviewLocation(chosen);
      else setPreviewLocation(null);
    } catch (_) {
      setPreviewLocation(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const finalCategory = formData.category || 'Other';
      const safePurchaseDate = normalizeDate(formData.purchase_date) || null;
      // Reuse the QR already shown in the label preview so a printed label always resolves to
      // the saved item (minting a fresh one here made the printed QR a dead code).
      const itemQr = previewItemQr ?? generateItemQrCode();

      const { data: item, error } = await supabase
        .from('items')
        .insert([{
          ...formData,
          category: finalCategory,
          qr_code: itemQr,
          purchase_price: formData.purchase_price ? parseFloat(formData.purchase_price) : null,
          purchase_date: safePurchaseDate
        }])
        .select()
        .single();

      if (error) throw error;

      // Advanced assignment: honor manual selection or auto-place
      let assignedLocationName: string | null = null;
      try {
        if (manualLocationId) {
          const chosen = locations.find((l:any) => l.id === manualLocationId);
          const { error: ilErr } = await supabase.from('item_locations').insert([
            { item_id: item.id, location_id: manualLocationId, quantity: formData.quantity }
          ]);
          if (!ilErr) assignedLocationName = chosen?.name || null;

          if (isPrintingSupported()) {
            try {
              const labelText = `${item.name} • ${finalCategory}${assignedLocationName ? ' @ ' + assignedLocationName : ''}`;
              await printTextLabel(labelText);
              // If this location was empty, print its label too
              const { data: occNow } = await supabase.from('item_locations').select('id').eq('location_id', manualLocationId).is('date_removed', null);
              if ((occNow?.length || 0) === 1 && manualLocationId) {
                await autoPrintLabel(manualLocationId);
              }
            } catch (printErr) {
              console.warn('Printing labels failed:', printErr);
            }
          }
        } else {
          const norm = (s?: string) => (s || '').toLowerCase();
          const text = `${formData.name} ${formData.description} ${formData.notes}`.toLowerCase();
          const categoryKey = norm(finalCategory);

          const { data: locsAll, error: locErr } = await supabase
            .from('locations')
            .select('*');

          if (!locErr && Array.isArray(locsAll) && locsAll.length) {
            // Current occupancy per location (only active placements)
            const { data: occRows } = await supabase
              .from('item_locations')
              .select('location_id')
              .is('date_removed', null);

            const occMap = new Map<string, number>();
            occRows?.forEach((r: any) => {
              const id = (r.location_id as string) || '';
              occMap.set(id, (occMap.get(id) || 0) + 1);
            });

            const hasAny = (arr: string[]) => arr.some(k => text.includes(k));
            const socketKeywords = ['socket','ratchet','torx','1/4"','3/8"','1/2"','hex bit socket','extension'];
            const smallParts = ['screw','bolt','nut','washer','nail','anchor','fastener','o-ring','zip tie','clip','fuse','connector','terminal'];
            const pegKeywords = ['wrench','pliers','screwdriver','hammer','tape measure','square','level','saw','clamp','chisel','mallet'];
            const powerKeywords = ['drill','driver','grinder','sander','router','planer','circular saw','miter','reciprocating saw','jigsaw','multi-tool','dremel'];

            const preferSockets = hasAny(socketKeywords) || /socket/i.test(formData.name);
            const preferBins = hasAny(smallParts) || categoryKey === 'fasteners' || /small|mixed parts/.test(text);
            const preferPeg = hasAny(pegKeywords) || ['hand tools','measuring tools','cutting tools'].includes(categoryKey);
            const preferPower = hasAny(powerKeywords) || categoryKey === 'power tools';

            const isLarge = /large|table|floor|stand|heavy|4x8|4x 8|4\s*x\s*8/i.test(text) ||
              ((formData.size_specs || '').toLowerCase().includes('inch') && /2[5-9]|[3-9]\d/.test(formData.size_specs || ''));

            const fits = (loc: any) => {
              // Never auto-place a tool into a place/space (Garage, Shed…) — only real storage.
              if (String(loc.type).toLowerCase() === 'space') return false;
              const cap = (loc.capacity as number | null) ?? null;
              const occ = occMap.get(loc.id) || 0;
              return cap === null || occ < cap;
            };

            const byLowestOcc = (a: any, b: any) => {
              const oa = occMap.get(a.id) || 0;
              const ob = occMap.get(b.id) || 0;
              return oa - ob;
            };

            const findFirst = (filterFn: (l:any)=>boolean) => locsAll.filter(filterFn).filter(fits).sort(byLowestOcc)[0];

            let chosen: any | undefined;

            // Prioritize AI placement suggestion if available
            if (!chosen && aiPlacement) {
              const t = norm(aiPlacement);
              if (t === 'sockets-drawer') {
                chosen = findFirst(l => norm(l.type) === 'drawer' && /socket/.test(norm(l.name)));
              } else if (t === 'bin') {
                chosen = findFirst(l => norm(l.type) === 'bin');
              } else if (t === 'pegboard') {
                chosen = findFirst(l => norm(l.type) === 'pegboard');
              } else if (t === 'drawer') {
                chosen = findFirst(l => norm(l.type) === 'drawer' && /4x8|4x 8|4\s*x\s*8/.test(norm(l.name))) || findFirst(l => norm(l.type) === 'drawer');
              } else if (t === 'large-area') {
                chosen = findFirst(l => /large.*area/.test(norm(l.name)) || norm(l.type) === 'rack');
              } else if (t === 'general-shelf') {
                chosen = findFirst(l => /general/.test(norm(l.name)) || norm(l.type) === 'shelf');
              }
            }

            if (!chosen && preferSockets) {
              chosen = findFirst(l => norm(l.type) === 'drawer' && /socket/.test(norm(l.name)));
              if (!chosen) chosen = findFirst(l => /socket/.test(norm(l.name)));
            }
            if (!chosen && preferBins) {
              chosen = findFirst(l => norm(l.type) === 'bin');
            }
            if (!chosen && preferPeg) {
              chosen = findFirst(l => norm(l.type) === 'pegboard');
            }
            if (!chosen && preferPower) {
              chosen = findFirst(l => norm(l.type) === 'drawer' && /4x8|4x 8|4\s*x\s*8/.test(norm(l.name)))
                || findFirst(l => norm(l.type) === 'drawer');
            }
            if (!chosen && isLarge) {
              chosen = findFirst(l => /large.*area/.test(norm(l.name)) || /large/.test(norm(l.name)));
            }
            if (!chosen) {
              chosen = findFirst(l => /general/.test(norm(l.name)));
            }
            if (!chosen) {
              chosen = findFirst(() => true);
            }

            if (chosen) {
              const wasEmpty = (occMap.get(chosen.id) || 0) === 0;

              const { error: ilErr } = await supabase.from('item_locations').insert([
                { item_id: item.id, location_id: chosen.id, quantity: formData.quantity }
              ]);
              if (!ilErr) assignedLocationName = chosen.name;

              // Categorize bin on first assignment if it has no category
              if (norm(chosen.type) === 'bin' && (!chosen.category || !String(chosen.category).trim())) {
                await supabase
                  .from('locations')
                  .update({ category: finalCategory })
                  .eq('id', chosen.id);
              }

              // Print item label; if first item in location, also print location label
              if (isPrintingSupported()) {
                try {
                  const labelText = `${item.name} • ${finalCategory}${assignedLocationName ? ' @ ' + assignedLocationName : ''}`;
                  await printTextLabel(labelText);
                  if (wasEmpty) {
                    await autoPrintLabel(chosen.id);
                  }
                } catch (printErr) {
                  console.warn('Printing labels failed:', printErr);
                }
              }
            }
          }
        }
      } catch (assignErr) {
        console.error('Assign location failed:', assignErr);
      }

      toast({
        title: "Success",
        description: `Tool added${assignedLocationName ? ` and placed in ${assignedLocationName}` : ''}.`
      });

      // Reset form
      setFormData({
        name: "",
        description: "",
        category: "",
        brand: "",
        model: "",
        size_specs: "",
        quantity: 1,
        quantity_unit: "piece",
        purchase_date: "",
        purchase_price: "",
        notes: ""
      });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to add item. Please try again.",
        variant: "destructive"
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a tool</DialogTitle>
          <DialogDescription>
            Add a photo to identify the tool or extract text, then fill in details.
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Photo capture + AI identification is owned entirely by <ImageRecognition> below —
              the old standalone capture block here was redundant and its camera stream leaked. */}

          {/* Image Recognition Section */}
          <ImageRecognition 
            onToolIdentified={handleToolIdentified}
            onTextExtracted={handleTextExtracted}
            onAutoFill={handleAutoFill}
            onPlacementSuggested={(t) => setAiPlacement(t)}
            dimsInches={{
              length: dims.length ? Number(dims.length) : undefined,
              width: dims.width ? Number(dims.width) : undefined,
              height: dims.height ? Number(dims.height) : undefined,
            }}
          />

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                required
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="category">Category *</Label>
              <Select 
                value={formData.category} 
                onValueChange={(value) => {
                  if (value === "__add_category__") {
                    const name = window.prompt("New category name");
                    if (name && name.trim()) {
                      addCategory(name.trim());
                      setFormData(prev => ({ ...prev, category: name.trim() }));
                    }
                    return;
                  }
                  setFormData(prev => ({ ...prev, category: value }));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__add_category__">+ Add new category</SelectItem>
                  {categories.map(cat => (
                    <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Detailed description of the item..."
              />
            </div>

          <div className="space-y-2">
            <Label>Approximate dimensions (inches)</Label>
            <div className="grid grid-cols-3 gap-2">
              <Input placeholder="L" inputMode="decimal" value={dims.length} onChange={(e)=>setDims(p=>({...p,length:e.target.value}))} />
              <Input placeholder="W" inputMode="decimal" value={dims.width} onChange={(e)=>setDims(p=>({...p,width:e.target.value}))} />
              <Input placeholder="H" inputMode="decimal" value={dims.height} onChange={(e)=>setDims(p=>({...p,height:e.target.value}))} />
            </div>
            <p className="text-xs text-muted-foreground">26 gal bins ≈ 23.5 × 18 × 16.5 in. We’ll use dimensions to suggest storage.</p>
          </div>

          <div className="space-y-2">
            <Label>Assign Location (optional)</Label>
            <Select
              value={manualLocationId || "__auto__"}
              onValueChange={(v)=>{
                if (v === "__auto__") { setManualLocationId(""); setPreviewLocation(null); return; }
                setManualLocationId(v); const chosen = locations.find(l=>l.id===v); setPreviewLocation(chosen||null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Auto (AI/heuristics)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">Auto — let the app place it</SelectItem>
                {locations.map((l:any)=> (
                  <SelectItem key={l.id} value={l.id}>{l.name} • {l.type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="purchase_date">Purchase Date</Label>
              <Input
                id="purchase_date"
                type="date"
                value={formData.purchase_date}
                onChange={(e) => setFormData(prev => ({ ...prev, purchase_date: e.target.value }))}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="purchase_price">Purchase Price</Label>
              <Input
                id="purchase_price"
                type="number"
                step="0.01"
                min="0"
                value={formData.purchase_price}
                onChange={(e) => setFormData(prev => ({ ...prev, purchase_price: e.target.value }))}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Additional notes..."
            />
          </div>

          <div className="space-y-3">
            <Button type="button" variant="outline" onClick={handlePreviewLabels}>
              Preview label &amp; suggested spot <span className="ml-1.5 text-xs text-muted-foreground">(optional)</span>
            </Button>
            {previewItemQr && (
              <LabelPreview
                title="Item Label Preview"
                lines={[formData.name || 'New Item', formData.category || 'Other']}
                qrValue={previewItemQr}
              />
            )}
            {previewLocation && (
              <LabelPreview
                title="Location Label Preview"
                lines={[previewLocation.name, previewLocation.type]}
                qrValue={previewLocation.qr_code}
              />
            )}
          </div>

          <DialogFooter>
            <Button 
              type="button" 
              variant="outline" 
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !formData.name || !formData.category}>
              {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add tool
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}