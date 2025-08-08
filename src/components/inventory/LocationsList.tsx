import { useState, useEffect } from "react";
import { Plus, MapPin, QrCode, Edit, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Location {
  id: string;
  qr_code: string;
  name: string;
  type: string;
  parent_location_id?: string;
  capacity?: number;
  description?: string;
  created_at: string;
}

export function LocationsList() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    type: "",
    parent_location_id: "",
    capacity: "",
    description: ""
  });
  const { toast } = useToast();

  const locationTypes = [
    "bin", "pegboard", "drawer", "shelf", "hook", "rack", "cabinet"
  ];

  useEffect(() => {
    fetchLocations();
  }, []);

  const fetchLocations = async () => {
    try {
      const { data, error } = await supabase
        .from('locations')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setLocations(data || []);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to fetch locations",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const generateQRCode = () => {
    return `LOC-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const { data, error } = await supabase
        .from('locations')
        .insert([{
          ...formData,
          qr_code: generateQRCode(),
          capacity: formData.capacity ? parseInt(formData.capacity) : null,
          parent_location_id: formData.parent_location_id || null
        }])
        .select()
        .single();

      if (error) throw error;

      setLocations([data, ...locations]);
      toast({
        title: "Success",
        description: "Location added successfully!"
      });

      setFormData({
        name: "",
        type: "",
        parent_location_id: "",
        capacity: "",
        description: ""
      });
      setShowAddDialog(false);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to add location",
        variant: "destructive"
      });
    }
  };

  const deleteLocation = async (id: string) => {
    try {
      const { error } = await supabase
        .from('locations')
        .delete()
        .eq('id', id);

      if (error) throw error;
      
      setLocations(locations.filter(loc => loc.id !== id));
      toast({
        title: "Success",
        description: "Location deleted successfully"
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete location",
        variant: "destructive"
      });
    }
  };

  const getParentLocationName = (parentId?: string) => {
    if (!parentId) return null;
    const parent = locations.find(loc => loc.id === parentId);
    return parent?.name;
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center">
            <MapPin className="h-8 w-8 animate-pulse text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Locations ({locations.length})</CardTitle>
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Location
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {locations.length === 0 ? (
            <div className="text-center py-8">
              <MapPin className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">
                No locations created yet. Click 'Add Location' to get started!
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {locations.map(location => (
                <Card key={location.id} className="relative">
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <h3 className="font-semibold text-foreground">{location.name}</h3>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <QrCode className="h-3 w-3" />
                          <span className="font-mono">{location.qr_code}</span>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm">
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => deleteLocation(location.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    
                    <Badge variant="outline" className="mb-2 capitalize">
                      {location.type}
                    </Badge>
                    
                    {location.description && (
                      <p className="text-sm text-muted-foreground mb-2 line-clamp-2">
                        {location.description}
                      </p>
                    )}
                    
                    {getParentLocationName(location.parent_location_id) && (
                      <div className="text-xs text-muted-foreground mb-1">
                        Parent: {getParentLocationName(location.parent_location_id)}
                      </div>
                    )}
                    
                    {location.capacity && (
                      <div className="text-xs text-muted-foreground">
                        Capacity: {location.capacity}
                      </div>
                    )}
                    
                    <div className="mt-2 text-xs text-muted-foreground">
                      0 items stored
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Location</DialogTitle>
          </DialogHeader>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Location Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Workshop - East Wall - Pegboard 1"
                required
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="type">Type *</Label>
              <Select 
                value={formData.type} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, type: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select location type" />
                </SelectTrigger>
                <SelectContent>
                  {locationTypes.map(type => (
                    <SelectItem key={type} value={type} className="capitalize">
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="parent">Parent Location</Label>
              <Select 
                value={formData.parent_location_id} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, parent_location_id: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select parent location (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {locations.map(loc => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="capacity">Capacity</Label>
              <Input
                id="capacity"
                type="number"
                min="1"
                value={formData.capacity}
                onChange={(e) => setFormData(prev => ({ ...prev, capacity: e.target.value }))}
                placeholder="Maximum number of items"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Additional details about this location..."
              />
            </div>

            <DialogFooter>
              <Button 
                type="button" 
                variant="outline" 
                onClick={() => setShowAddDialog(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!formData.name || !formData.type}>
                Add Location
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}