// WebUSB API types for Brother QL printers
interface USBDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly manufacturerName: string;
  readonly configuration: USBConfiguration | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
}

interface USBConfiguration {
  readonly configurationValue: number;
}

interface USBOutTransferResult {
  readonly status: 'ok' | 'stall' | 'babble';
  readonly bytesWritten: number;
}

interface USBInTransferResult {
  readonly status: 'ok' | 'stall' | 'babble';
  readonly data: DataView;
}

interface PrinterService {
  isConnected: boolean;
  connect: () => Promise<boolean>;
  print: (data: number[]) => Promise<boolean>;
  disconnect: () => void;
}

class BrotherQLPrinterService implements PrinterService {
  private device: USBDevice | null = null;
  private outEndpoint: number = 1; // Default, will be detected
  private inEndpoint: number = 1; // Default, will be detected
  public isConnected = false;

  async connect(): Promise<boolean> {
    try {
      // Check if WebUSB API is supported
      if (!('usb' in navigator)) {
        throw new Error('WebUSB API not supported in this browser. Please use Chrome, Edge, or another Chromium-based browser.');
      }

      console.log('Requesting Brother QL printer connection via WebUSB...');

      // Request Brother QL device
      this.device = await (navigator as any).usb.requestDevice({
        filters: [
          {
            vendorId: 0x04f9, // Brother vendor ID
            classCode: 7,     // Printer class
          },
          {
            vendorId: 0x04f9, // Brother vendor ID  
            productId: 0x209b // QL-800 product ID
          },
          {
            vendorId: 0x04f9, // Brother vendor ID
            productId: 0x2100 // Alternative QL-800 product ID
          }
        ]
      });

      if (!this.device) {
        throw new Error('No Brother QL printer selected');
      }

      console.log('Brother QL printer found:', this.device.productName || 'Unknown Model');
      console.log('Vendor ID:', this.device.vendorId.toString(16));
      console.log('Product ID:', this.device.productId.toString(16));

      // Open the device
      await this.device.open();
      console.log('Device opened successfully');

      // Select configuration (try different configurations)
      if (this.device.configuration === null) {
        try {
          await this.device.selectConfiguration(1);
          console.log('Configuration 1 selected');
        } catch (error) {
          console.log('Configuration 1 failed, trying default');
        }
      }

      // Add delay to ensure device is ready
      await new Promise(resolve => setTimeout(resolve, 500));

      // Try to claim interface 0 first, then try interface 1 if that fails
      let interfaceClaimed = false;
      let claimedInterface = 0;
      
      for (let interfaceNum = 0; interfaceNum <= 2; interfaceNum++) {
        try {
          await this.device.claimInterface(interfaceNum);
          console.log(`Interface ${interfaceNum} claimed successfully`);
          
          interfaceClaimed = true;
          claimedInterface = interfaceNum;
          break;
        } catch (error) {
          console.log(`Failed to claim interface ${interfaceNum}:`, error);
        }
      }

      if (!interfaceClaimed) {
        throw new Error('Unable to claim any printer interface. Please close any Brother P-touch Editor or other printer software and try again.');
      }

      // Brother QL-800 typically uses endpoint 2 for out and endpoint 1 for in
      this.outEndpoint = 2;
      this.inEndpoint = 1;
      console.log(`Using OUT endpoint: ${this.outEndpoint}, IN endpoint: ${this.inEndpoint}`);

      // Store the claimed interface number for later use
      (this.device as any).claimedInterface = claimedInterface;

      this.isConnected = true;
      console.log('Successfully connected to Brother QL printer via WebUSB!');
      return true;

    } catch (error) {
      console.error('Failed to connect to Brother QL printer:', error);
      console.error('Troubleshooting steps:');
      console.error('1. Ensure Brother QL-800 is connected via USB');
      console.error('2. Make sure printer is powered on');
      console.error('3. Use Chrome/Edge browser (not Firefox/Safari)');
      console.error('4. Try disconnecting and reconnecting the USB cable');
      console.error('5. Close any Brother P-touch Editor or other printer software');
      
      this.isConnected = false;
      this.device = null;
      return false;
    }
  }

  async print(data: number[]): Promise<boolean> {
    if (!this.device || !this.isConnected) {
      throw new Error('Brother QL printer not connected');
    }

    try {
      console.log('Sending print data to Brother QL printer via WebUSB...');
      console.log('Data length:', data.length, 'bytes');

      // Convert data to Uint8Array
      const uint8Data = new Uint8Array(data);
      
      // Send data to Brother QL printer using detected endpoint
      const result = await this.device.transferOut(this.outEndpoint, uint8Data.buffer);
      
      if (result.status === 'ok') {
        console.log('Print data sent successfully via WebUSB');
        console.log('Bytes written:', result.bytesWritten);
        return true;
      } else {
        console.error('Print transfer failed with status:', result.status);
        return false;
      }

    } catch (error) {
      console.error('Failed to print via WebUSB:', error);
      return false;
    }
  }

  async getStatus(): Promise<any> {
    if (!this.device || !this.isConnected) {
      throw new Error('Brother QL printer not connected');
    }

    try {
      // Request status
      const statusRequest = new Uint8Array([0x1B, 0x69, 0x53]);
      await this.device.transferOut(1, statusRequest.buffer);
      
      // Read status response
      const result = await this.device.transferIn(1, 32);
      return result.data;
    } catch (error) {
      console.error('Failed to get printer status:', error);
      return null;
    }
  }

  async testPrint(): Promise<boolean> {
    if (!this.device || !this.isConnected) {
      throw new Error('Brother QL printer not connected');
    }

    try {
      console.log('Sending universal test print...');

      // Universal Brother QL commands that work with any paper
      const testCommands: number[] = [
        // Initialize printer
        0x1B, 0x40, // ESC @ - Initialize printer
        
        // Switch to raster mode
        0x1B, 0x69, 0x52, 0x01,
        
        // Auto cut (but don't specify paper type)
        0x1B, 0x69, 0x4D, 0x40,
        
        // Set compression mode off
        0x1B, 0x69, 0x4B, 0x08,
      ];

      // Very simple, small test pattern that should work on any Brother QL paper
      const labelHeight = 20; // Very small test
      const bytesPerLine = 60; // Conservative width that fits most papers

      // Add raster data for simple test pattern
      for (let line = 0; line < labelHeight; line++) {
        // Raster line command
        testCommands.push(0x67, 0x00, bytesPerLine);
        
        // Create simple test pattern
        for (let byte = 0; byte < bytesPerLine; byte++) {
          if (line === 0 || line === labelHeight - 1 || byte === 0 || byte === bytesPerLine - 1) {
            testCommands.push(0xFF); // Border
          } else if (line === 10 && byte >= 20 && byte <= 40) {
            testCommands.push(0xFF); // Center line
          } else {
            testCommands.push(0x00); // White
          }
        }
      }

      // Print command
      testCommands.push(0x1A);

      // Convert to Uint8Array and send using the detected output endpoint
      const uint8Data = new Uint8Array(testCommands);
      const result = await this.device.transferOut(this.outEndpoint, uint8Data.buffer);
      
      if (result.status === 'ok') {
        console.log('Test print sent successfully');
        return true;
      } else {
        console.error('Test print failed with status:', result.status);
        return false;
      }

    } catch (error) {
      console.error('Failed to send test print:', error);
      return false;
    }
  }

  disconnect(): void {
    if (this.device) {
      try {
        this.device.releaseInterface(0);
        this.device.close();
        console.log('Brother QL printer disconnected');
      } catch (error) {
        console.error('Error disconnecting printer:', error);
      }
      this.device = null;
      this.isConnected = false;
    }
  }
}

// Singleton printer service
export const printerService = new BrotherQLPrinterService();

// Auto-print function using Supabase edge function with status reporting
export async function autoPrintLabel(
  locationId: string, 
  onStatusUpdate?: (status: string) => void
): Promise<{ success: boolean; message: string }> {
  try {
    onStatusUpdate?.('Connecting to printer...');
    
    // Connect to printer if not already connected
    if (!printerService.isConnected) {
      console.log('Printer not connected, attempting to connect...');
      const connected = await printerService.connect();
      if (!connected) {
        return {
          success: false,
          message: 'Failed to connect to Brother QL printer via WebUSB. Please ensure it\'s connected via USB and try again.'
        };
      }
    }

    onStatusUpdate?.('Generating label data...');
    
    // Get print data from the edge function using Supabase client
    const { supabase } = await import('@/integrations/supabase/client');
    
    console.log('Requesting print data for location:', locationId);
    const { data: result, error } = await supabase.functions.invoke('print-location-label', {
      body: { locationId, autoFormat: true } // Request auto-format mode
    });

    if (error) {
      throw new Error(error.message || 'Failed to generate print data');
    }

    if (!result.success) {
      throw new Error(result.error || 'Failed to generate print data');
    }

    onStatusUpdate?.('Sending to printer...');
    console.log('Print data received from edge function, sending to printer...');

    // Send print commands to printer
    const printed = await printerService.print(result.printData);
    
    if (printed) {
      onStatusUpdate?.('Print complete!');
      return {
        success: true,
        message: `Label printed successfully for ${result.location.name}!`
      };
    } else {
      return {
        success: false,
        message: 'Failed to send data to Brother QL printer via WebUSB'
      };
    }

  } catch (error) {
    console.error('Auto-print error:', error);
    return {
      success: false,
      message: `Print failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

// Test print function
export async function testPrint(): Promise<{ success: boolean; message: string }> {
  try {
    // Connect to printer if not already connected
    if (!printerService.isConnected) {
      console.log('Printer not connected, attempting to connect...');
      const connected = await printerService.connect();
      if (!connected) {
        return {
          success: false,
          message: 'Failed to connect to Brother QL printer. Please ensure it\'s connected via USB and try again.'
        };
      }
    }

    console.log('Sending test print...');
    const printed = await printerService.testPrint();
    
    if (printed) {
      return {
        success: true,
        message: 'Test print sent successfully! Check your printer for output.'
      };
    } else {
      return {
        success: false,
        message: 'Failed to send test print to Brother QL printer'
      };
    }

  } catch (error) {
    console.error('Test print error:', error);
    return {
      success: false,
      message: `Test print failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

// Browser compatibility check
export function isPrintingSupported(): boolean {
  return 'usb' in navigator;
}

// Manual printer connection for first-time setup
export async function setupPrinter(): Promise<boolean> {
  if (!isPrintingSupported()) {
    alert('WebUSB API is not supported in your browser. Please use Chrome, Edge, or another Chromium-based browser.');
    return false;
  }

  return await printerService.connect();
}
