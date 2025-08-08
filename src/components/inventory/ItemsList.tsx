import { useState, useEffect } from "react";
import { Search, Package, Edit, Trash2, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  const { toast } = useToast();

  const categories = [
    "all", "Power Tools", "Hand Tools", "Fasteners", "Hardware", 
    "Safety Equipment", "Electrical", "Plumbing", "Cutting Tools", 
    "Measuring Tools", "Other"
  ];

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
    <Card>
      <CardHeader>
        <CardTitle>Items ({filteredItems.length})</CardTitle>
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search items..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="px-3 py-2 border border-input rounded-md bg-background text-foreground"
          >
            {categories.map(cat => (
              <option key={cat} value={cat}>
                {cat === "all" ? "All Categories" : cat}
              </option>
            ))}
          </select>
        </div>
      </CardHeader>
      <CardContent>
        {filteredItems.length === 0 ? (
          <div className="text-center py-8">
            <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">
              {searchTerm || selectedCategory !== "all" 
                ? "No items match your search criteria" 
                : "No items added yet. Click 'Add Item' to get started!"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredItems.map(item => (
              <Card key={item.id} className="relative">
                <CardContent className="p-4">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <h3 className="font-semibold text-foreground">{item.name}</h3>
                      {item.brand && (
                        <p className="text-sm text-muted-foreground">{item.brand}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm">
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={() => deleteItem(item.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  
                  <Badge variant="secondary" className="mb-2">
                    {item.category}
                  </Badge>
                  
                  {item.description && (
                    <p className="text-sm text-muted-foreground mb-2 line-clamp-2">
                      {item.description}
                    </p>
                  )}
                  
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      Qty: {item.quantity} {item.quantity_unit}
                    </span>
                    {item.purchase_price && (
                      <span className="text-foreground font-medium">
                        ${item.purchase_price}
                      </span>
                    )}
                  </div>
                  
                  <div className="flex items-center mt-2 text-xs text-muted-foreground">
                    <MapPin className="h-3 w-3 mr-1" />
                    <span>No location assigned</span>
                  </div>
                  
                  {item.model && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Model: {item.model}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}