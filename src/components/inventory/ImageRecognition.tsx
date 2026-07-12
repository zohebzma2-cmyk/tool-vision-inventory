import { useState, useRef, useId } from "react";
import { Camera, Upload, Eye, FileText, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/adaptive-dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { compressImage } from "@/lib/image";
import { supabase } from "@/integrations/supabase/client";
import { printTextLabel, isPrintingSupported, setupPrinter } from "@/components/inventory/PrinterService";


interface RecognitionResult {
  type: 'classification' | 'ocr';
  results: Array<{
    label: string;
    score?: number;
    text?: string;
  }>;
}

interface ImageRecognitionProps {
  onToolIdentified?: (toolInfo: { name: string; category: string; confidence: number }) => void;
  onTextExtracted?: (text: string) => void;
  onAutoFill?: (fields: Partial<{
    name: string;
    description: string;
    category: string;
    brand: string;
    model: string;
    size_specs: string;
    purchase_date: string;
    purchase_price: string;
    notes: string;
  }>) => void;
  onPlacementSuggested?: (type: string) => void;
  dimsInches?: { length?: number; width?: number; height?: number };
}

export function ImageRecognition({ onToolIdentified, onTextExtracted, onAutoFill, onPlacementSuggested, dimsInches }: ImageRecognitionProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<RecognitionResult | null>(null);
  const [recognitionMode, setRecognitionMode] = useState<'classify' | 'ocr'>('classify');
  const [classifierReady, setClassifierReady] = useState(false);
  const [ocrReady, setOcrReady] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const uploadInputId = useId();
  const cameraInputId = useId();
  
  // Camera capture mode state/refs
  const [isCameraMode, setIsCameraMode] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { toast } = useToast();

  const handleImageSelect = (file: File) => {
    console.log('handleImageSelect called with file:', file);
    setSelectedImage(file);
    setResults(null);
    
    // Downscale before anything else — the preview and the AI payload both use this,
    // and vision inference cost scales steeply with resolution.
    compressImage(file, 960, 0.65)
      .then(setImagePreview)
      .catch(() => {
        const reader = new FileReader();
        reader.onload = (e) => setImagePreview(e.target?.result as string);
        reader.readAsDataURL(file);
      });
  };

  // Camera controls
  const startCamera = async () => {
    console.log('startCamera called');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setIsCameraActive(true);
    } catch (err) {
      console.error('getUserMedia error:', err);
      toast({
        title: 'Camera Error',
        description: 'Could not access camera. Check browser permissions.',
        variant: 'destructive'
      });
      setIsCameraMode(false);
    }
  };

  const stopCamera = () => {
    const stream = videoRef.current?.srcObject as MediaStream | undefined;
    stream?.getTracks().forEach((t) => t.stop());
    setIsCameraActive(false);
  };

  const capturePhoto = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current ?? document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], 'camera.jpg', { type: 'image/jpeg' });
        handleImageSelect(file);
        setIsCameraMode(false);
        stopCamera();
      }
    }, 'image/jpeg', 0.9);
  };

  const processImageClassification = async (imageUrl: string) => {
    console.log('Starting image classification via Google Vision');
    try {
      setIsProcessing(true);
      const { data, error } = await supabase.functions.invoke('openai-vision', {
        body: { imageDataUrl: imageUrl, mode: 'identify', dimsInches }
      });
      if (error) throw error;
      const specific = data?.specificName as string | undefined;
      const confidence = (data?.confidence as number | undefined) ?? 0;
      const labels = (data?.labels ?? []).slice(0, 3);
      const categoryFromAI: string | undefined = (data?.category as string | undefined) || undefined;
      const placementType: string | undefined = typeof data?.placementType === 'string' ? data.placementType : undefined;

      const toolResults = [
        ...(specific ? [{ label: specific, score: confidence, category: categoryFromAI || mapToToolCategory(specific) }] : []),
        ...labels.map((l: any) => ({ label: l.description, score: l.score, category: mapToToolCategory(l.description) })),
      ];

      setResults({ type: 'classification', results: toolResults });
      const top = toolResults[0];
      if (top && (top.score ?? 0) > 0.3) {
        const topCategory = categoryFromAI || top.category;
        onToolIdentified?.({ name: top.label, category: topCategory, confidence: top.score! });
      }

      if (placementType) {
        onPlacementSuggested?.(placementType);
      }

      if (data?.dimensionQuestion) {
        toast({ title: 'Size needed', description: String(data.dimensionQuestion) });
      }

      // Build auto-fill suggestions using Vision web/entities/text
      const rawText: string = (data?.text as string) || '';
      const webEntities: Array<any> = (data?.webEntities as any[]) || [];
      const bestLabel: string = labels?.[0]?.description || '';
      const name: string = specific || bestLabel;

      const brandCandidate = (webEntities.find((w: any) => typeof w.description === 'string' && /[A-Za-z]/.test(w.description) && w.description.length <= 20)?.description) || '';
      const modelMatch = rawText.match(/[A-Z]{1,3}[- ]?\d{2,6}[A-Z0-9-]*/);
      const sizeMatches = rawText.match(/\b\d+(?:\.\d+)?\s?(?:mm|cm|m|in|"|inch|inches|ft|g|kg|lb|oz|AWG|gauge|V|W|A)\b/gi);
      const priceMatch = rawText.match(/(?:USD\s*)?\$\s?(\d{1,4}(?:\.\d{2})?)/i) || rawText.match(/\b(\d{1,4}\.\d{2})\b/);
      const dateMatch = rawText.match(/\b(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})\b/);

      let purchase_date = '';
      if (dateMatch?.[1]) {
        const d = dateMatch[1].replace(/[.]/g, '-');
        if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(d)) {
          purchase_date = d;
        } else {
          const parts = d.split(/[\/\-]/);
          if (parts.length === 3) {
            const [p1, p2, p3] = parts; // assume MM/DD/YYYY
            if (p3.length === 4) {
              const mm = p1.padStart(2, '0');
              const dd = p2.padStart(2, '0');
              purchase_date = `${p3}-${mm}-${dd}`;
            }
          }
        }
      }

      onAutoFill?.({
        name,
        category: categoryFromAI || (name ? mapToToolCategory(name) : undefined),
        description: name ? `${name} — ${toolResults.slice(0,2).map(r => r.label).join(', ')}` : undefined,
        brand: brandCandidate || undefined,
        model: modelMatch?.[0] || undefined,
        size_specs: sizeMatches ? Array.from(new Set(sizeMatches)).slice(0,3).join(', ') : undefined,
        purchase_price: priceMatch?.[1] || undefined,
        purchase_date: purchase_date || undefined,
      });

      // Auto-print top result to streamline workflow
      try {
        const topLabel = name || toolResults[0]?.label;
        if (topLabel) {
          if (isPrintingSupported()) {
            const { success, message } = await printTextLabel(topLabel);
            toast({ title: success ? 'Label printed' : 'Print failed', description: message, variant: success ? undefined : 'destructive' });
          } else {
            toast({ title: 'Printing not supported', description: 'Use Chrome/Edge on desktop to print labels.' });
          }
        }
      } catch (e) {
        toast({ title: 'Auto-print failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
      }

      setClassifierReady(true);
    } catch (error: any) {
      console.error('Classification error:', error);
      const rawMsg = error?.message || '';
      const needsBilling = /billing|BILLING_DISABLED|PERMISSION_DENIED/i.test(rawMsg);
      const description = needsBilling
        ? 'Google Cloud Vision billing is not enabled. Please enable billing for your GCP project and retry.'
        : (rawMsg || 'Failed to classify the image. Please try again.');
      toast({ title: 'Recognition Failed', description, variant: 'destructive' });
    } finally {
      setIsProcessing(false);
    }
  };

  const processImageOCR = async (imageUrl: string) => {
    try {
      setIsProcessing(true);
      const { data, error } = await supabase.functions.invoke('openai-vision', {
        body: { imageDataUrl: imageUrl, mode: 'ocr' }
      });
      if (error) throw error;
      const extractedText = data?.text || 'No text found';
      setResults({ type: 'ocr', results: [{ label: 'Extracted Text', text: extractedText }] });
      onTextExtracted?.(extractedText);
      setOcrReady(true);
    } catch (error: any) {
      console.error('OCR error:', error);
      const rawMsg = error?.message || '';
      const needsBilling = /billing|BILLING_DISABLED|PERMISSION_DENIED/i.test(rawMsg);
      const description = needsBilling
        ? 'Google Cloud Vision billing is not enabled. Please enable billing for your GCP project and retry.'
        : (rawMsg || 'Failed to extract text from the image. Please try again.');
      toast({ title: 'Text Recognition Failed', description, variant: 'destructive' });
    } finally {
      setIsProcessing(false);
    }
  };

  const mapToToolCategory = (label: string): string => {
    const toolMappings: Record<string, string> = {
      'hammer': 'hand tools',
      'screwdriver': 'hand tools',
      'wrench': 'hand tools',
      'pliers': 'hand tools',
      'drill': 'power tools',
      'saw': 'cutting tools',
      'knife': 'cutting tools',
      'ruler': 'measuring tools',
      'level': 'measuring tools',
      'screw': 'fasteners',
      'nail': 'fasteners',
      'bolt': 'fasteners',
      'nut': 'fasteners',
      'tool': 'general tools',
      'equipment': 'equipment',
      'machine': 'machinery'
    };

    const normalizedLabel = label.toLowerCase();
    for (const [key, category] of Object.entries(toolMappings)) {
      if (normalizedLabel.includes(key)) {
        return category;
      }
    }
    return 'miscellaneous';
  };

  const processImage = async () => {
    console.log('processImage called with:', { selectedImage, imagePreview, recognitionMode });
    if (!selectedImage || !imagePreview) {
      console.log('Missing selectedImage or imagePreview, aborting');
      return;
    }

    if (recognitionMode === 'classify') {
      console.log('Starting classification mode');
      await processImageClassification(imagePreview);
    } else {
      console.log('Starting OCR mode');
      await processImageOCR(imagePreview);
    }
  };

  const handlePrintTop = async () => {
    try {
      if (results?.type !== 'classification' || !results.results[0]?.label) return;
      const topLabel = results.results[0]!.label;
      if (!isPrintingSupported()) {
        toast({ title: 'Printing not supported', description: 'Use Chrome/Edge on desktop to print labels.', variant: 'destructive' });
        return;
      }
      setIsProcessing(true);
      const { success, message } = await printTextLabel(topLabel);
      toast({ title: success ? 'Label sent to printer' : 'Print failed', description: message, variant: success ? undefined : 'destructive' });
    } catch (e) {
      toast({ title: 'Print failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <>
      <Card className="border-0 shadow-soft">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Eye className="h-4 w-4" />
            Image Recognition
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Identify tools or extract text from images
            </div>
            
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => {
                  console.log('Identify Tool button clicked');
                  setRecognitionMode('classify');
                  setShowDialog(true);
                }}
                className="flex-1"
              >
                <Camera className="h-4 w-4 mr-2" />
                Identify Tool
              </Button>
              
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => {
                  setRecognitionMode('ocr');
                  setShowDialog(true);
                }}
                className="flex-1"
              >
                <FileText className="h-4 w-4 mr-2" />
                Extract Text
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={(open) => { if (!open) { stopCamera(); setIsCameraMode(false); } setShowDialog(open); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {recognitionMode === 'classify' ? (
                <>
                  <Eye className="h-5 w-5" />
                  Tool Identification
                </>
              ) : (
                <>
                  <FileText className="h-5 w-5" />
                  Text Extraction
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              Choose or capture an image, then click the button below to {recognitionMode === 'classify' ? 'identify the tool' : 'extract text'}.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            {/* Image Upload Section */}
            <div className="grid grid-cols-2 gap-3">
              <div className="relative">
                <Button
                  variant="outline"
                  className="h-24 w-full flex flex-col gap-2 pointer-events-none"
                >
                  <Upload className="h-6 w-6" />
                  <span className="text-sm">Upload Image</span>
                </Button>
                <input
                  id={uploadInputId}
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  aria-label="Upload image file"
                  onClick={() => console.log('Upload input clicked')}
                  onChange={(e) => {
                    console.log('File input changed, files:', e.target.files);
                    e.target.files?.[0] && handleImageSelect(e.target.files[0]);
                  }}
                  className="absolute inset-0 z-50 h-full w-full opacity-0 cursor-pointer block"
                />
              </div>

              <div className="relative">
                <Button
                  variant="outline"
                  className="h-24 w-full flex flex-col gap-2"
                  onClick={() => {
                    console.log('Take Photo clicked');
                    setIsCameraMode(true);
                    startCamera();
                  }}
                >
                  <Camera className="h-6 w-6" />
                  <span className="text-sm">Take Photo</span>
                </Button>
              </div>
            </div>

            {isCameraMode && (
              <div className="space-y-2">
                <div className="rounded-md overflow-hidden border">
                  <video
                    ref={videoRef}
                    className="w-full max-h-64 bg-muted"
                    autoPlay
                    playsInline
                    muted
                  />
                  <canvas ref={canvasRef} className="hidden" />
                </div>
                <div className="flex gap-2">
                  <Button type="button" onClick={capturePhoto} disabled={!isCameraActive}>Capture</Button>
                  <Button type="button" variant="outline" onClick={() => { stopCamera(); setIsCameraMode(false); }}>Cancel</Button>
                </div>
              </div>
            )}

            {/* Image Preview */}
            {imagePreview && (
              <div className="space-y-4">
                <Card className="bg-muted/20 border-0">
                  <CardContent className="p-4">
                    <img
                      src={imagePreview}
                      alt="Selected image"
                      className="max-w-full h-auto max-h-64 mx-auto rounded-md"
                    />
                  </CardContent>
                </Card>

                <Button
                  onClick={processImage}
                  disabled={isProcessing}
                  className="w-full"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {recognitionMode === 'classify' ? 'Identifying...' : 'Extracting Text...'}
                    </>
                  ) : (
                    <>
                      {recognitionMode === 'classify' ? (
                        <Eye className="h-4 w-4 mr-2" />
                      ) : (
                        <FileText className="h-4 w-4 mr-2" />
                      )}
                      {recognitionMode === 'classify' ? 'Identify Tool' : 'Extract Text'}
                    </>
                  )}
                </Button>
              </div>
            )}

            {/* Results Display */}
            {results && (
              <>
                <Card className="bg-success/5 border-success/20">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      {results.type === 'classification' ? (
                        <>
                          <Eye className="h-4 w-4 text-success" />
                          Recognition Results
                        </>
                      ) : (
                        <>
                          <FileText className="h-4 w-4 text-success" />
                          Extracted Text
                        </>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {results.type === 'classification' ? (
                      <div className="space-y-2">
                        {results.results.map((result, index) => (
                          <div key={index} className="flex items-center justify-between p-2 bg-white/50 rounded-md">
                            <div className="flex-1">
                              <div className="font-medium text-sm capitalize">{result.label}</div>
                              <div className="text-xs text-muted-foreground">
                                Category: {(result as any).category}
                              </div>
                            </div>
                            {result.score && (
                              <Badge variant="outline" className="text-xs">
                                {Math.round(result.score * 100)}%
                              </Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="p-3 bg-white/50 rounded-md">
                        <div className="text-sm font-mono whitespace-pre-wrap">
                          {results.results[0]?.text || 'No text found'}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {results.type === 'classification' && (
                  <div className="flex justify-end pt-2">
                    <Button size="sm" onClick={handlePrintTop} disabled={isProcessing}>
                      Print Top Result
                    </Button>
                  </div>
                )}
              </>
            )}

            {/* Status Indicators */}
            <div className="flex gap-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                {classifierReady || recognitionMode === 'ocr' ? (
                  <div className="w-2 h-2 bg-success rounded-full" />
                ) : (
                  <div className="w-2 h-2 bg-muted-foreground rounded-full" />
                )}
                Tool Recognition
              </div>
              <div className="flex items-center gap-1">
                {ocrReady || recognitionMode === 'classify' ? (
                  <div className="w-2 h-2 bg-success rounded-full" />
                ) : (
                  <div className="w-2 h-2 bg-muted-foreground rounded-full" />
                )}
                Text Extraction
              </div>
            </div>

            <div className="bg-info/10 border border-info/20 rounded-md p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-info mt-0.5 flex-shrink-0" />
                <div className="text-sm text-info">
                  <div className="font-medium mb-1">AI Processing Notes:</div>
                  <ul className="text-xs space-y-1 list-disc list-inside">
                    <li>High-accuracy detection powered by OpenAI GPT-4o-mini (vision)</li>
                    <li>Works best with clear, well-lit images of tools</li>
                    <li>Text extraction works best with printed text and labels</li>
                    <li>Processing runs via a secure Supabase Edge Function</li>

                  </ul>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}