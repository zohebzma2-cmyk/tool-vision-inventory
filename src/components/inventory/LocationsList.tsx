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
          parent_location_id: formData.parent_location_id === "none" ? null : formData.parent_location_id || null
        }])
        .select()
        .single();

      if (error) throw error;

      setLocations([data, ...locations]);
      
      // Print label for the new location
      try {
        const { data: printResult, error: printError } = await supabase.functions.invoke('print-location-label', {
          body: { locationId: data.id }
        });

        if (printError) {
          console.error('Print error:', printError);
          toast({
            title: "Location Added",
            description: `Location created successfully, but printing failed: ${printError.message}`,
            variant: "destructive"
          });
        } else {
          toast({
            title: "Location Added & Label Generated",
            description: `Location created and label generated! ${printResult.instructions}`,
          });
          
          // If you want to show the label preview, you could open it in a new window
          if (printResult.labelSVG) {
            const blob = new Blob([printResult.labelSVG], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
          }
        }
      } catch (printError) {
        console.error('Print function error:', printError);
        toast({
          title: "Location Added",
          description: "Location created successfully, but label printing is unavailable.",
        });
      }

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
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Locations ({locations.length})
            </h2>
            <p className="text-sm text-muted-foreground">
              Organize your workspace with QR-coded locations
            </p>
          </div>
          <Button 
            onClick={() => setShowAddDialog(true)}
            className="shadow-soft"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Location
          </Button>
        </div>

        {locations.length === 0 ? (
          <div className="text-center py-12">
            <div className="mx-auto w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-4">
              <MapPin className="h-10 w-10 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No locations yet</h3>
            <p className="text-muted-foreground max-w-sm mx-auto">
              Create your first location to start organizing your tools with QR codes for easy tracking.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {locations.map(location => (
              <Card key={location.id} className="group hover:shadow-soft transition-all duration-200 border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex-1">
                      <h3 className="font-semibold text-foreground text-lg mb-1">{location.name}</h3>
                      <div className="flex items-center gap-1 text-sm text-muted-foreground bg-muted/50 rounded-md px-2 py-1 w-fit">
                        <QrCode className="h-3 w-3" />
                        <span className="font-mono text-xs">{location.qr_code}</span>
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={() => deleteLocation(location.id)}
                        className="h-8 w-8 p-0 hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  
                  <Badge 
                    variant="outline" 
                    className="mb-3 capitalize bg-accent/10 text-accent border-accent/20"
                  >
                    {location.type}
                  </Badge>
                  
                  {location.description && (
                    <p className="text-sm text-muted-foreground mb-3 line-clamp-2 leading-relaxed">
                      {location.description}
                    </p>
                  )}
                  
                  <div className="space-y-2">
                    {getParentLocationName(location.parent_location_id) && (
                      <div className="text-xs text-muted-foreground">
                        Parent: <span className="font-medium">{getParentLocationName(location.parent_location_id)}</span>
                      </div>
                    )}
                    
                    {location.capacity && (
                      <div className="text-xs text-muted-foreground">
                        Capacity: <span className="font-medium">{location.capacity} items</span>
                      </div>
                    )}
                    
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Items stored:</span>
                      <Badge variant="secondary" className="text-xs bg-success/10 text-success border-success/20">
                        0 items
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

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
                value={formData.parent_location_id || "none"} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, parent_location_id: value === "none" ? "" : value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select parent location (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
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