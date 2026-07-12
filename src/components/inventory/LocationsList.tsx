import { useState, useEffect } from "react";
import { Plus, MapPin, QrCode, Edit, Trash2, Printer, Settings, TestTube, Eye, Grid3x3 } from "lucide-react";
import { MapSpaceDialog } from "./MapSpaceDialog";
import { SpaceMap } from "./SpaceMap";
import { LabelTemplateEditor } from "./LabelTemplateEditor";
import { Tags } from "lucide-react";
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
import { autoPrintLabel, setupPrinter, isPrintingSupported, printerService, testPrint } from "./PrinterService";
import { PaperTypeConfig } from "./PaperTypeConfig";
import { ImageRecognition } from "./ImageRecognition";
import { LabelPreview } from "@/components/inventory/LabelPreview";

interface Location {
  id: string;
  qr_code: string;
  name: string;
  type: string;
  parent_location_id?: string;
  capacity?: number;
  description?: string;
  created_at: string;
  grid_rows?: number | null;
  grid_cols?: number | null;
  is_slot?: boolean;
  layout?: { labelTemplateId?: string } | null;
}

export function LocationsList() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showMapDialog, setShowMapDialog] = useState(false);
  const [mapLoc, setMapLoc] = useState<Location | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [autoPrintEnabled, setAutoPrintEnabled] = useState(true);
  const [printerConnected, setPrinterConnected] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    type: "",
    parent_location_id: "",
    capacity: "",
    description: ""
  });
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFormData, setEditFormData] = useState({
    name: "",
    type: "",
    parent_location_id: "",
    capacity: "",
    description: ""
  });
  const { toast } = useToast();

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoc, setPreviewLoc] = useState<Location | null>(null);

  const locationTypes = [
    "bin", "pegboard", "drawer", "shelf", "hook", "rack", "cabinet"
  ];

  useEffect(() => {
    fetchLocations();
    setPrinterConnected(printerService.isConnected);
  }, []);

  const fetchLocations = async () => {
    try {
      const [locsRes, linksRes, itemsRes] = await Promise.all([
        supabase.from('locations').select('*').eq('is_slot', false).order('created_at', { ascending: false }),
        supabase.from('item_locations').select('item_id, location_id').is('date_removed', null),
        supabase.from('items').select('id, name')
      ]);

      if (locsRes.error) throw locsRes.error;
      if (linksRes.error) throw linksRes.error;
      if (itemsRes.error) throw itemsRes.error;

      const locations = locsRes.data || [];
      const links = linksRes.data || [];
      const items = itemsRes.data || [];

      const nameByItemId = new Map<string, string>();
      (items as any[]).forEach((it:any) => nameByItemId.set(it.id, it.name));

      const namesByLoc = new Map<string, string[]>();
      (links as any[]).forEach((l:any) => {
        const nm = nameByItemId.get(l.item_id);
        if (!nm) return;
        const arr = namesByLoc.get(l.location_id) || [];
        if (!arr.includes(nm)) arr.push(nm);
        namesByLoc.set(l.location_id, arr);
      });

      const enriched = (locations as any[]).map((loc:any) => ({
        ...loc,
        __itemNames: namesByLoc.get(loc.id) || []
      }));

      setLocations(enriched as any);
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
      
      // Auto-print label if enabled and printer is available
      if (autoPrintEnabled && isPrintingSupported()) {
        try {
          let currentStatus = "Preparing to print...";
          
          // Show initial toast with status
          const { dismiss } = toast({
            title: "Location Added!",
            description: currentStatus,
            duration: 10000, // Keep it visible during printing
          });

          const printResult = await autoPrintLabel(data.id, (status) => {
            currentStatus = status;
            dismiss(); // Remove previous toast
            toast({
              title: "Location Added!",
              description: status,
              duration: status === 'Print complete!' ? 3000 : 10000,
            });
          });
          
          dismiss(); // Remove any remaining toast
          
          if (printResult.success) {
            toast({
              title: "Success!",
              description: printResult.message,
            });
          } else {
            toast({
              title: "Location Added",
              description: `Location created successfully. Print failed: ${printResult.message}`,
              variant: "destructive"
            });
          }
        } catch (printError) {
          console.error('Auto-print error:', printError);
          toast({
            title: "Location Added",
            description: "Location created but auto-printing failed. Please print manually.",
            variant: "destructive"
          });
        }
      } else {
        toast({
          title: "Location Added",
          description: "Location created successfully!",
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

  const handleSetupPrinter = async () => {
    const connected = await setupPrinter();
    setPrinterConnected(connected);
    
    if (connected) {
      toast({
        title: "Printer Connected",
        description: "Brother QL-800 connected successfully! Labels will now auto-print.",
      });
    } else {
      toast({
        title: "Connection Failed",
        description: "Could not connect to Brother QL-800. Please check USB connection.",
        variant: "destructive"
      });
    }
  };

  const handleTestPrint = async () => {
    const result = await testPrint();
    
    if (result.success) {
      toast({
        title: "Test Print Sent",
        description: result.message,
      });
    } else {
      toast({
        title: "Test Print Failed",
        description: result.message,
        variant: "destructive"
      });
    }
  };

  const handlePrintLocation = async (id: string) => {
    if (!isPrintingSupported()) {
      toast({ title: "Printing Unavailable", description: "Printer not connected.", variant: "destructive" });
      return;
    }
    let currentStatus = "Preparing to print...";
    const { dismiss } = toast({
      title: "Printing Label",
      description: currentStatus,
      duration: 10000,
    });
    try {
      const result = await autoPrintLabel(id, (status) => {
        currentStatus = status;
        dismiss();
        toast({ title: "Printing Label", description: status, duration: status === 'Print complete!' ? 3000 : 10000 });
      });
      dismiss();
      if (result.success) {
        toast({ title: "Printed", description: result.message });
      } else {
        toast({ title: "Print Failed", description: result.message, variant: "destructive" });
      }
    } catch (e: any) {
      dismiss();
      toast({ title: "Print Error", description: String(e?.message || e), variant: "destructive" });
    }
  };

  const openEdit = (loc: Location) => {
    setEditingId(loc.id);
    setEditFormData({
      name: loc.name,
      type: loc.type,
      parent_location_id: loc.parent_location_id || "",
      capacity: loc.capacity ? String(loc.capacity) : "",
      description: loc.description || ""
    });
    setShowEditDialog(true);
  };

  const handleUpdateLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    try {
      const { data, error } = await supabase
        .from('locations')
        .update({
          name: editFormData.name,
          type: editFormData.type,
          capacity: editFormData.capacity ? parseInt(editFormData.capacity) : null,
          parent_location_id: editFormData.parent_location_id === "none" ? null : (editFormData.parent_location_id || null),
          description: editFormData.description || null
        })
        .eq('id', editingId)
        .select()
        .single();
      if (error) throw error;
      setLocations(prev => prev.map(l => l.id === editingId ? data : l));
      toast({ title: "Location Updated", description: "Changes saved successfully." });
      setShowEditDialog(false);
      setEditingId(null);
    } catch (err) {
      toast({ title: "Update Failed", description: "Could not save changes.", variant: "destructive" });
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
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div className="flex items-baseline gap-2">
            <h2 className="font-display text-xl font-semibold uppercase tracking-wide text-foreground">
              Spaces
            </h2>
            <span className="font-mono text-sm text-muted-foreground">({locations.length})</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {isPrintingSupported() && (
              <>
                <Button 
                  variant="outline"
                  size="sm"
                  onClick={handleSetupPrinter}
                  className={printerConnected ? "bg-success/10 border-success text-success" : ""}
                >
                  <Printer className="h-4 w-4 mr-2" />
                  {printerConnected ? "Printer Ready" : "Setup Printer"}
                </Button>
                {printerConnected && (
                  <Button 
                    variant="outline"
                    size="sm"
                    onClick={handleTestPrint}
                  >
                    <TestTube className="h-4 w-4 mr-2" />
                    Test Print
                  </Button>
                )}
              </>
            )}
            <Button
              variant="outline"
              onClick={() => setShowTemplates(true)}
            >
              <Tags className="h-4 w-4 mr-2" />
              Templates
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowMapDialog(true)}
              className="shadow-soft"
            >
              <Grid3x3 className="h-4 w-4 mr-2" />
              Map a Space
            </Button>
            <Button
              onClick={() => setShowAddDialog(true)}
              className="shadow-soft"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add space
            </Button>
          </div>
        </div>

        {/* Configuration and Tools Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {isPrintingSupported() && (
            <PaperTypeConfig onPaperTypeChange={(paperType) => {
              console.log('Paper type changed to:', paperType);
            }} />
          )}
          
          <ImageRecognition 
            onToolIdentified={(toolInfo) => {
              console.log('Tool identified:', toolInfo);
              toast({
                title: "Tool Identified",
                description: `Found: ${toolInfo.name} (${Math.round(toolInfo.confidence * 100)}% confidence)`,
              });
            }}
            onTextExtracted={(text) => {
              console.log('Text extracted:', text);
              toast({
                title: "Text Extracted",
                description: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
              });
            }}
          />
        </div>

        {locations.length === 0 ? (
          <div className="text-center py-12">
            <div className="mx-auto w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-4">
              <MapPin className="h-10 w-10 text-muted-foreground" />
            </div>
            <h3 className="font-display text-lg font-semibold uppercase tracking-wide mb-2">No spaces mapped</h3>
            <p className="text-muted-foreground max-w-sm mx-auto">
              Point the camera at a pegboard, drawer, or shelf and Map a Space turns it
              into a labeled grid of slots.
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
                      {location.grid_rows && location.grid_cols && (
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="View slot map" onClick={() => setMapLoc(location)}>
                          <Grid3x3 className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => { setPreviewLoc(location); setPreviewOpen(true); }}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => openEdit(location)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => handlePrintLocation(location.id)}>
                        <Printer className="h-4 w-4" />
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
                    
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Items stored:</span>
                        <Badge variant="secondary" className="text-xs bg-success/10 text-success border-success/20">
                          {((location as any).__itemNames?.length || 0)} item{(((location as any).__itemNames?.length || 0) === 1) ? '' : 's'}
                        </Badge>
                      </div>
                      {((location as any).__itemNames?.length || 0) > 0 && (
                        <div className="text-xs text-muted-foreground">
                          <span className="font-medium">{(location as any).__itemNames.slice(0,3).join(', ')}</span>
                          {((location as any).__itemNames.length > 3) && (
                            <span className="ml-1">+{(location as any).__itemNames.length - 3} more</span>
                          )}
                        </div>
                      )}
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
                onValueChange={(value) => setFormData(prev => ({ ...prev, parent_location_id: value == "none" ? "" : value }))}
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
                Add space
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Location</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleUpdateLocation} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Location Name *</Label>
              <Input
                id="edit-name"
                value={editFormData.name}
                onChange={(e) => setEditFormData(prev => ({ ...prev, name: e.target.value }))}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-type">Type *</Label>
              <Select 
                value={editFormData.type} 
                onValueChange={(value) => setEditFormData(prev => ({ ...prev, type: value }))}
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
              <Label htmlFor="edit-parent">Parent Location</Label>
              <Select 
                value={editFormData.parent_location_id || "none"} 
                onValueChange={(value) => setEditFormData(prev => ({ ...prev, parent_location_id: value === "none" ? "" : value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select parent location (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {locations
                    .filter(l => l.id !== editingId)
                    .map(loc => (
                      <SelectItem key={loc.id} value={loc.id}>
                        {loc.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-capacity">Capacity</Label>
              <Input
                id="edit-capacity"
                type="number"
                min="1"
                value={editFormData.capacity}
                onChange={(e) => setEditFormData(prev => ({ ...prev, capacity: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={editFormData.description}
                onChange={(e) => setEditFormData(prev => ({ ...prev, description: e.target.value }))}
              />
            </div>

            <DialogFooter>
              <Button 
                type="button" 
                variant="outline" 
                onClick={() => setShowEditDialog(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!editFormData.name || !editFormData.type}>
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <MapSpaceDialog
        open={showMapDialog}
        onOpenChange={setShowMapDialog}
        onCreated={fetchLocations}
      />

      <SpaceMap
        open={!!mapLoc}
        onOpenChange={(v) => { if (!v) setMapLoc(null); }}
        location={mapLoc}
      />

      <LabelTemplateEditor open={showTemplates} onOpenChange={setShowTemplates} />

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Location Label Preview</DialogTitle>
          </DialogHeader>
          {previewLoc && (
            <LabelPreview
              title="Location Label"
              lines={[previewLoc.name, previewLoc.type]}
              qrValue={previewLoc.qr_code}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

