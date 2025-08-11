import { useState, useRef, useId } from "react";
import { Camera, Upload, Eye, FileText, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { pipeline, env } from '@huggingface/transformers';

// Configure transformers.js
env.allowLocalModels = false;
env.useBrowserCache = true;

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
}

export function ImageRecognition({ onToolIdentified, onTextExtracted }: ImageRecognitionProps) {
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
  const { toast } = useToast();

  const handleImageSelect = (file: File) => {
    console.log('handleImageSelect called with file:', file);
    setSelectedImage(file);
    setResults(null);
    
    const reader = new FileReader();
    reader.onload = (e) => {
      console.log('FileReader loaded, setting preview');
      setImagePreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const processImageClassification = async (imageUrl: string) => {
    console.log('Starting image classification process with URL:', imageUrl);
    try {
      setIsProcessing(true);
      console.log('Set processing to true');
      
      // Load the image classification model with fallback
      let classifier;
      console.log('Attempting to load classifier with WebGPU...');
      try {
        classifier = await pipeline(
          'image-classification',
          'microsoft/resnet-50',
          { device: 'webgpu' }
        );
        console.log('WebGPU classifier loaded successfully');
      } catch (webgpuError) {
        console.log('WebGPU not available, falling back to CPU:', webgpuError);
        classifier = await pipeline(
          'image-classification',
          'microsoft/resnet-50'
        );
        console.log('CPU classifier loaded successfully');
      }
      
      setClassifierReady(true);
      
      const results = await classifier(imageUrl);
      
      // Filter and map results to tool categories
      const toolResults = results.slice(0, 5).map((result: any) => ({
        label: result.label,
        score: result.score,
        category: mapToToolCategory(result.label)
      }));

      setResults({
        type: 'classification',
        results: toolResults
      });

      // Notify parent component of the top result if it's tool-related
      const topResult = toolResults[0];
      if (topResult && topResult.score > 0.3) {
        onToolIdentified?.({
          name: topResult.label,
          category: topResult.category,
          confidence: topResult.score
        });
      }

    } catch (error) {
      console.error('Classification error:', error);
      toast({
        title: "Recognition Failed",
        description: "Failed to classify the image. Please try again.",
        variant: "destructive"
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const processImageOCR = async (imageUrl: string) => {
    try {
      setIsProcessing(true);
      
      // Load the OCR model with fallback
      let ocr;
      try {
        ocr = await pipeline(
          'image-to-text',
          'Xenova/trocr-base-printed',
          { device: 'webgpu' }
        );
      } catch (webgpuError) {
        console.log('WebGPU not available, falling back to CPU:', webgpuError);
        ocr = await pipeline(
          'image-to-text',
          'Xenova/trocr-base-printed'
        );
      }
      
      setOcrReady(true);
      
      const result = await ocr(imageUrl);
      
      // Handle different result types from the OCR model
      let extractedText = 'No text found';
      if (Array.isArray(result) && result.length > 0) {
        if (typeof result[0] === 'string') {
          extractedText = result[0];
        } else if (result[0] && typeof result[0] === 'object') {
          // Handle object with generated_text property
          extractedText = (result[0] as any).generated_text || result[0].toString();
        }
      } else if (typeof result === 'string') {
        extractedText = result;
      }
      
      setResults({
        type: 'ocr',
        results: [{ label: 'Extracted Text', text: extractedText }]
      });

      onTextExtracted?.(extractedText);

    } catch (error) {
      console.error('OCR error:', error);
      toast({
        title: "Text Recognition Failed",
        description: "Failed to extract text from the image. Please try again.",
        variant: "destructive"
      });
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

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
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
                  onChange={(e) => {
                    console.log('File input changed, files:', e.target.files);
                    e.target.files?.[0] && handleImageSelect(e.target.files[0]);
                  }}
                  className="absolute inset-0 z-10 opacity-0 cursor-pointer"
                />
              </div>

              <div className="relative">
                <Button
                  variant="outline"
                  className="h-24 w-full flex flex-col gap-2 pointer-events-none"
                >
                  <Camera className="h-6 w-6" />
                  <span className="text-sm">Take Photo</span>
                </Button>
                <input
                  id={cameraInputId}
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => {
                    console.log('Camera input changed, files:', e.target.files);
                    e.target.files?.[0] && handleImageSelect(e.target.files[0]);
                  }}
                  className="absolute inset-0 z-10 opacity-0 cursor-pointer"
                />
              </div>
            </div>


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
                    <li>Models are loaded on first use - initial processing may take longer</li>
                    <li>Works best with clear, well-lit images of tools</li>
                    <li>Text extraction works best with printed text and labels</li>
                    <li>Processing happens locally in your browser for privacy</li>
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