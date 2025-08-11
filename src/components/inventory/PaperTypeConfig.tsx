import { useState, useEffect } from "react";
import { Settings, CheckCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { LABEL_SIZES, type LabelSpec } from "@/utils/brotherQL";

interface PaperTypeConfigProps {
  onPaperTypeChange?: (paperType: string) => void;
}

export function PaperTypeConfig({ onPaperTypeChange }: PaperTypeConfigProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [selectedPaperType, setSelectedPaperType] = useState<string>('62');
  const [currentPaperSpec, setCurrentPaperSpec] = useState<LabelSpec>(LABEL_SIZES['62']);
  const { toast } = useToast();

  useEffect(() => {
    // Load saved paper type from localStorage
    const savedPaperType = localStorage.getItem('brother-ql-paper-type');
    if (savedPaperType && LABEL_SIZES[savedPaperType]) {
      setSelectedPaperType(savedPaperType);
      setCurrentPaperSpec(LABEL_SIZES[savedPaperType]);
    }
  }, []);

  const handlePaperTypeChange = (paperType: string) => {
    const spec = LABEL_SIZES[paperType];
    if (!spec) return;

    setSelectedPaperType(paperType);
    setCurrentPaperSpec(spec);
    
    // Save to localStorage
    localStorage.setItem('brother-ql-paper-type', paperType);
    
    // Notify parent component
    onPaperTypeChange?.(paperType);
    
    toast({
      title: "Paper Type Updated",
      description: `Set to ${spec.name}`,
    });
    
    setShowDialog(false);
  };

  const getPaperTypeColor = (kind: string) => {
    switch (kind) {
      case 'endless':
        return 'bg-primary/10 text-primary border-primary/20';
      case 'die_cut':
        return 'bg-accent/10 text-accent border-accent/20';
      case 'round_die_cut':
        return 'bg-info/10 text-info border-info/20';
      default:
        return 'bg-muted/10 text-muted-foreground border-muted/20';
    }
  };

  return (
    <>
      <Card className="border-0 shadow-soft">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Paper Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground">{currentPaperSpec.name}</div>
                <div className="text-xs text-muted-foreground">
                  {currentPaperSpec.width_mm}mm width
                  {currentPaperSpec.height_mm && ` × ${currentPaperSpec.height_mm}mm height`}
                </div>
              </div>
              <Badge variant="outline" className={getPaperTypeColor(currentPaperSpec.kind)}>
                {currentPaperSpec.kind.replace('_', ' ')}
              </Badge>
            </div>
            
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setShowDialog(true)}
              className="w-full"
            >
              <Settings className="h-4 w-4 mr-2" />
              Configure Paper Type
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Configure Paper Type
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Select Paper Type</Label>
              <Select value={selectedPaperType} onValueChange={setSelectedPaperType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select paper type" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(LABEL_SIZES).map(([key, spec]) => (
                    <SelectItem key={key} value={key}>
                      <div className="flex items-center justify-between w-full">
                        <span>{spec.name}</span>
                        <Badge 
                          variant="outline" 
                          className={`ml-2 text-xs ${getPaperTypeColor(spec.kind)}`}
                        >
                          {spec.kind.replace('_', ' ')}
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedPaperType && LABEL_SIZES[selectedPaperType] && (
              <Card className="bg-muted/20 border-0">
                <CardContent className="p-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-4 w-4 text-success" />
                      <span className="font-medium text-sm">Paper Specifications</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-muted-foreground">Width:</span>
                        <div className="font-medium">{LABEL_SIZES[selectedPaperType].width_mm}mm</div>
                      </div>
                      {LABEL_SIZES[selectedPaperType].height_mm && (
                        <div>
                          <span className="text-muted-foreground">Height:</span>
                          <div className="font-medium">{LABEL_SIZES[selectedPaperType].height_mm}mm</div>
                        </div>
                      )}
                      <div>
                        <span className="text-muted-foreground">Type:</span>
                        <div className="font-medium capitalize">{LABEL_SIZES[selectedPaperType].kind.replace('_', ' ')}</div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Print Width:</span>
                        <div className="font-medium">{LABEL_SIZES[selectedPaperType].dots_printable[0]}px</div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="bg-info/10 border border-info/20 rounded-md p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-info mt-0.5 flex-shrink-0" />
                <div className="text-sm text-info">
                  <div className="font-medium mb-1">Important Notes:</div>
                  <ul className="text-xs space-y-1 list-disc list-inside">
                    <li>Ensure the selected paper type matches your actual label roll</li>
                    <li>Red/black paper types require compatible Brother QL printers</li>
                    <li>Endless labels have variable length, die-cut labels have fixed dimensions</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setShowDialog(false)}
            >
              Cancel
            </Button>
            <Button 
              onClick={() => handlePaperTypeChange(selectedPaperType)}
              disabled={!selectedPaperType}
            >
              Apply Configuration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}