import { useState, useEffect } from "react";
import { Search, Package, Edit, Trash2, MapPin, Eye } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/adaptive-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useCategories } from "@/hooks/useCategories";
import { LabelPreview } from "@/components/inventory/LabelPreview";

interface Item {
  id: string;
  name: string;
  description?: string;
  category: string;
  brand?: string;
  model?: string;
  size_specs?: string;
  quantity: number;
  quantity_unit: string;
  photo_path?: string;
  purchase_date?: string;
  purchase_price?: number;
  notes?: string;
  date_added: string;
  last_seen?: string;
  qr_code?: string;
}

export function ItemsList() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFormData, setEditFormData] = useState({
    name: "",
    category: "",
    description: "",
    brand: "",
    model: "",
    size_specs: "",
    quantity: 1,
    quantity_unit: "piece",
    purchase_date: "",
    purchase_price: "",
    notes: "",
  });
  const { toast } = useToast();

  const { categories, addCategory, categoriesForFilter } = useCategories();
  const [showPreview, setShowPreview] = useState(false);
  const [previewItem, setPreviewItem] = useState<Item | null>(null);
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [editLocationId, setEditLocationId] = useState<string>("");
  const [initialEditLocationId, setInitialEditLocationId] = useState<string>("");

  const normalizeDate = (v?: string): string | null => {
    if (!v) return null;
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      const [_, y, m, d] = iso;
      const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
      return isNaN(dt.getTime()) ? null : `${y}-${m}-${d}`;
    }
    const mdy = v.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
    if (mdy) {
      let [__, mm, dd, yy] = mdy as any;
      if (yy.length === 2) yy = String(2000 + Number(yy));
      const m = String(Number(mm)).padStart(2, '0');
      const d = String(Number(dd)).padStart(2, '0');
      const dt = new Date(`${yy}-${m}-${d}T00:00:00Z`);
      return isNaN(dt.getTime()) ? null : `${yy}-${m}-${d}`;
    }
    return null;
  };

  useEffect(() => {
    fetchItems();
  }, []);

  const fetchItems = async () => {
    try {
      const [{ data: itemsData, error: itemsErr }, { data: links, error: linksErr }, { data: locs, error: locsErr }] = await Promise.all([
        supabase.from('items').select('*').order('date_added', { ascending: false }),
        supabase.from('item_locations').select('item_id, location_id').is('date_removed', null),
        supabase.from('locations').select('id, name')
      ]);

      if (itemsErr) throw itemsErr;
      if (linksErr) throw linksErr;
      if (locsErr) throw locsErr;

      setItems(itemsData || []);

      const nameByLoc = new Map<string, string>();
      (locs || []).forEach(l => nameByLoc.set((l as any).id, (l as any).name));
      const itemToLoc = new Map<string, string>();
      (links || []).forEach(l => {
        const n = nameByLoc.get((l as any).location_id);
        if (n && !itemToLoc.has((l as any).item_id)) itemToLoc.set((l as any).item_id, n);
      });
      // attach locationName onto items for quick render
      setItems(prev => (itemsData || []).map(it => ({ ...(it as any), __locationName: itemToLoc.get((it as any).id) || null })) as any);
      setLocations((locs || []) as any);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to fetch items",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const filteredItems = items.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         item.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         item.brand?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         item.model?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesCategory = selectedCategory === "all" || item.category === selectedCategory;
    
    return matchesSearch && matchesCategory;
  });

  const deleteItem = async (id: string) => {
    try {
      const { error } = await supabase
        .from('items')
        .delete()
        .eq('id', id);

      if (error) throw error;
      
      setItems(items.filter(item => item.id !== id));
      toast({
        title: "Success",
        description: "Item deleted successfully"
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete item",
        variant: "destructive"
      });
    }
  };

  const openEdit = async (item: Item) => {
    setEditingId(item.id);
    setEditFormData({
      name: item.name,
      category: item.category,
      description: item.description || '',
      brand: item.brand || '',
      model: item.model || '',
      size_specs: item.size_specs || '',
      quantity: item.quantity,
      quantity_unit: item.quantity_unit,
      purchase_date: item.purchase_date || '',
      purchase_price: item.purchase_price != null ? String(item.purchase_price) : '',
      notes: item.notes || ''
    });
    try {
      if (!locations.length) {
        const { data: locs } = await supabase.from('locations').select('id, name').order('name');
        setLocations(locs || []);
      }
      const { data: currLink } = await supabase
        .from('item_locations')
        .select('location_id')
        .eq('item_id', item.id)
        .is('date_removed', null)
        .maybeSingle();
      const locId = (currLink as any)?.location_id || "";
      setEditLocationId(locId);
      setInitialEditLocationId(locId);
    } catch {}
    setShowEditDialog(true);
  };

  const handleUpdateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    try {
      const { data, error } = await supabase
        .from('items')
        .update({
          name: editFormData.name,
          category: editFormData.category,
          description: editFormData.description || null,
          brand: editFormData.brand || null,
          model: editFormData.model || null,
          size_specs: editFormData.size_specs || null,
          quantity: Number(editFormData.quantity) || 1,
          quantity_unit: editFormData.quantity_unit,
          purchase_date: normalizeDate(editFormData.purchase_date),
          purchase_price: editFormData.purchase_price ? parseFloat(editFormData.purchase_price) : null,
          notes: editFormData.notes || null,
        })
        .eq('id', editingId)
        .select()
        .single();

      if (error) throw error;

      // Update location assignment if changed
      try {
        if (editLocationId !== initialEditLocationId) {
          await supabase
            .from('item_locations')
            .update({ date_removed: new Date().toISOString() })
            .eq('item_id', editingId)
            .is('date_removed', null);

          if (editLocationId) {
            await supabase.from('item_locations').insert([
              { item_id: editingId, location_id: editLocationId, quantity: Number(editFormData.quantity) || 1 }
            ]);
          }
        }
      } catch (e) {
        toast({ title: 'Location update issue', description: 'Item saved, but location change may not have been applied.', variant: 'destructive' });
      }

      const newLocName = editLocationId ? (locations.find((l:any) => (l as any).id === editLocationId)?.name || null) : null;

      setItems(prev => prev.map(i => i.id === editingId ? { ...i, ...data, __locationName: newLocName } : i));
      toast({ title: 'Item Updated', description: 'Changes saved successfully.' });
      setShowEditDialog(false);
      setEditingId(null);
    } catch (err) {
      toast({ title: 'Update Failed', description: 'Could not save changes.', variant: 'destructive' });
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center">
            <Package className="h-8 w-8 animate-pulse text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="p-6">
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Find a tool — name, brand, or model"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 h-10"
          />
        </div>
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          className="px-4 py-2 border border-input rounded-md bg-background text-foreground h-10 min-w-[160px]"
        >
          {categoriesForFilter.map(cat => (
            <option key={cat} value={cat}>
              {cat === "all" ? "All Categories" : cat}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4 flex items-baseline gap-2">
        <h2 className="font-display text-xl font-semibold uppercase tracking-wide text-foreground">
          Tools
        </h2>
        <span className="font-mono text-sm text-muted-foreground">({filteredItems.length})</span>
      </div>

      {filteredItems.length === 0 ? (
        <div className="text-center py-12">
          <div className="mx-auto w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-4">
            <Package className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="font-display text-lg font-semibold uppercase tracking-wide mb-2">
            {searchTerm || selectedCategory !== "all"
              ? "No tools match"
              : "Empty wall"}
          </h3>
          <p className="text-muted-foreground max-w-sm mx-auto">
            {searchTerm || selectedCategory !== "all"
              ? "Clear the search or pick a different category."
              : "Add your first tool — point the camera at it and the app fills in the details."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredItems.map(item => (
            <Card key={item.id} className="group hover:shadow-soft transition-all duration-200 border-0 shadow-sm">
              <CardContent className="p-5">
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1">
                    <h3 className="font-semibold text-foreground text-lg mb-1">{item.name}</h3>
                    {item.brand && (
                      <p className="text-sm text-muted-foreground font-medium uppercase tracking-wide">{item.brand}</p>
                    )}
                  </div>
                  <div className="flex gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => { setPreviewItem(item); setShowPreview(true); }}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => openEdit(item)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => deleteItem(item.id)}
                      className="h-8 w-8 p-0 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                
                <span className="label-tile inline-block px-2 py-0.5 text-[11px] mb-3">
                  {item.category}
                </span>

                <div className="text-[11px] text-muted-foreground font-mono mb-2 space-x-3 truncate">
                  {item.qr_code && <span className="truncate">QR: {item.qr_code}</span>}
                  <span className="truncate">ID: {item.id.slice(0, 8)}</span>
                </div>
                
                {item.description && (
                  <p className="text-sm text-muted-foreground mb-3 line-clamp-2 leading-relaxed">
                    {item.description}
                  </p>
                )}
                
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      Quantity: <span className="font-medium text-foreground">{item.quantity} {item.quantity_unit}</span>
                    </span>
                    {item.purchase_price && (
                      <span className="font-mono font-medium text-foreground">
                        ${item.purchase_price}
                      </span>
                    )}
                  </div>
                  
                  <div className="flex items-center text-xs text-muted-foreground bg-muted/50 rounded-md px-2 py-1">
                    <MapPin className="h-3 w-3 mr-1" />
                    <span>{(item as any).__locationName ? (item as any).__locationName : 'No location assigned'}</span>
                  </div>
                  
                  {item.model && (
                    <div className="text-xs text-muted-foreground">
                      Model: <span className="font-medium">{item.model}</span>
                    </div>
                  )}
                  
                  {item.size_specs && (
                    <div className="text-xs text-muted-foreground">
                      Size: <span className="font-medium">{item.size_specs}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Item</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleUpdateItem} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Name *</Label>
                <Input id="edit-name" value={editFormData.name} onChange={(e) => setEditFormData(p => ({ ...p, name: e.target.value }))} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-category">Category *</Label>
                <Select value={editFormData.category} onValueChange={(v) => {
                  if (v === "__add_category__") {
                    const name = window.prompt("New category name");
                    if (name && name.trim()) {
                      addCategory(name.trim());
                      setEditFormData(p => ({ ...p, category: name.trim() }));
                    }
                    return;
                  }
                  setEditFormData(p => ({ ...p, category: v }))
                }}>
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
              <Label htmlFor="edit-description">Description</Label>
              <Textarea id="edit-description" value={editFormData.description} onChange={(e) => setEditFormData(p => ({ ...p, description: e.target.value }))} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-brand">Brand</Label>
                <Input id="edit-brand" value={editFormData.brand} onChange={(e) => setEditFormData(p => ({ ...p, brand: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-model">Model</Label>
                <Input id="edit-model" value={editFormData.model} onChange={(e) => setEditFormData(p => ({ ...p, model: e.target.value }))} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-quantity">Quantity</Label>
                <Input id="edit-quantity" type="number" min="1" value={editFormData.quantity} onChange={(e) => setEditFormData(p => ({ ...p, quantity: Number(e.target.value) }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-unit">Unit</Label>
                <Select value={editFormData.quantity_unit} onValueChange={(v) => setEditFormData(p => ({ ...p, quantity_unit: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="piece">Piece</SelectItem>
                    <SelectItem value="set">Set</SelectItem>
                    <SelectItem value="box">Box</SelectItem>
                    <SelectItem value="kg">Kg</SelectItem>
                    <SelectItem value="meter">Meter</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-size">Size/Specs</Label>
                <Input id="edit-size" value={editFormData.size_specs} onChange={(e) => setEditFormData(p => ({ ...p, size_specs: e.target.value }))} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Assign Location</Label>
              <Select value={editLocationId || "__none__"} onValueChange={(v) => setEditLocationId(v === "__none__" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="No location" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No location</SelectItem>
                  {locations.map((l:any) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-date">Purchase Date</Label>
                <Input id="edit-date" type="date" value={editFormData.purchase_date} onChange={(e) => setEditFormData(p => ({ ...p, purchase_date: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-price">Purchase Price</Label>
                <Input id="edit-price" type="number" step="0.01" min="0" value={editFormData.purchase_price} onChange={(e) => setEditFormData(p => ({ ...p, purchase_price: e.target.value }))} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-notes">Notes</Label>
              <Textarea id="edit-notes" value={editFormData.notes} onChange={(e) => setEditFormData(p => ({ ...p, notes: e.target.value }))} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowEditDialog(false)}>Cancel</Button>
              <Button type="submit" disabled={!editFormData.name || !editFormData.category}>Save Changes</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Item Label Preview</DialogTitle>
          </DialogHeader>
          {previewItem && (
            <LabelPreview
              title="Item Label"
              lines={[previewItem.name, previewItem.category]}
              qrValue={previewItem.qr_code || `ITEM:${previewItem.id}`}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
