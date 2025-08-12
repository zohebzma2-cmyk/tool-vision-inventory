import { useState, useEffect } from "react";
import { Search, Package, Edit, Trash2, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

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

  const categories = [
    "all", "Power Tools", "Hand Tools", "Fasteners", "Hardware", 
    "Safety Equipment", "Electrical", "Plumbing", "Cutting Tools", 
    "Measuring Tools", "Other"
  ];
  const itemCategories = [
    "Power Tools", "Hand Tools", "Fasteners", "Hardware", 
    "Safety Equipment", "Electrical", "Plumbing", "Cutting Tools", 
    "Measuring Tools", "Other"
  ];

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
      const { data, error } = await supabase
        .from('items')
        .select('*')
        .order('date_added', { ascending: false });

      if (error) throw error;
      setItems(data || []);
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

  const openEdit = (item: Item) => {
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
      setItems(prev => prev.map(i => i.id === editingId ? { ...i, ...data } : i));
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
            placeholder="Search items by name, brand, model..."
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
          {categories.map(cat => (
            <option key={cat} value={cat}>
              {cat === "all" ? "All Categories" : cat}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">
          Items ({filteredItems.length})
        </h2>
        <p className="text-sm text-muted-foreground">
          Manage your tool inventory and track locations
        </p>
      </div>

      {filteredItems.length === 0 ? (
        <div className="text-center py-12">
          <div className="mx-auto w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-4">
            <Package className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">
            {searchTerm || selectedCategory !== "all" 
              ? "No matching items found" 
              : "No items in inventory"}
          </h3>
          <p className="text-muted-foreground max-w-sm mx-auto">
            {searchTerm || selectedCategory !== "all" 
              ? "Try adjusting your search criteria or add new items to your inventory." 
              : "Start building your tool inventory by adding your first item."}
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
                      <p className="text-sm text-primary font-medium">{item.brand}</p>
                    )}
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
                
                <Badge 
                  variant="secondary" 
                  className="mb-3 bg-primary/10 text-primary border-primary/20"
                >
                  {item.category}
                </Badge>
                
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
                      <span className="text-accent font-semibold text-base">
                        ${item.purchase_price}
                      </span>
                    )}
                  </div>
                  
                  <div className="flex items-center text-xs text-muted-foreground bg-muted/50 rounded-md px-2 py-1">
                    <MapPin className="h-3 w-3 mr-1" />
                    <span>No location assigned</span>
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
        <DialogContent>
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
                <Select value={editFormData.category} onValueChange={(v) => setEditFormData(p => ({ ...p, category: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {itemCategories.map(cat => (
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
    </div>
  );
}
