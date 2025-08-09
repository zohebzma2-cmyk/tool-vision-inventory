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

      // Try different endpoint configurations based on the claimed interface
      // Brother QL-800 typically uses endpoint 1 for interface 0, or endpoint 2 for other interfaces
      if (claimedInterface === 0) {
        this.outEndpoint = 1;
        this.inEndpoint = 1;
        console.log('Interface 0 claimed');
      } else {
        this.outEndpoint = 2;
        this.inEndpoint = 1;
        console.log(`Interface ${claimedInterface} claimed`);
      }
      
      console.log(`Using OUT endpoint: ${this.outEndpoint}, IN endpoint: ${this.inEndpoint}`);

      // Store the claimed interface number for later use
      (this.device as any).claimedInterface = claimedInterface;

      this.isConnected = true;
      console.log('Successfully connected to Brother QL printer via WebUSB!');
      return true;

    } catch (error) {
      console.error('Failed to connect to Brother QL printer:', error);
      
      if (error instanceof Error && error.name === 'SecurityError') {
        console.error('SECURITY ERROR: Device access denied. This usually means:');
        console.error('1. Brother P-touch Editor or other Brother software is running - CLOSE IT COMPLETELY');
        console.error('2. Windows printer spooler has locked the device - try restarting the printer');
        console.error('3. Another browser tab or application is using the printer');
        console.error('4. The printer driver is interfering - try using "Generic USB Printer" driver');
        console.error('');
        console.error('SOLUTION: Close ALL Brother software, restart the printer, then try again.');
      } else {
        console.error('Troubleshooting steps:');
        console.error('1. Ensure Brother QL-800 is connected via USB');
        console.error('2. Make sure printer is powered on');
        console.error('3. Use Chrome/Edge browser (not Firefox/Safari)');
        console.error('4. Try disconnecting and reconnecting the USB cable');
        console.error('5. Close any Brother P-touch Editor or other printer software');
      }
      
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
      console.log('Requesting printer status...');
      // Request status information
      const statusRequest = new Uint8Array([0x1B, 0x69, 0x53]);
      await this.device.transferOut(this.outEndpoint, statusRequest.buffer);
      
      // Add delay for printer to process
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Read status response (Brother QL returns 32 bytes)
      const result = await this.device.transferIn(this.inEndpoint, 32);
      
      if (result.status === 'ok' && result.data.byteLength > 0) {
        const statusData = new Uint8Array(result.data.buffer);
        console.log('Status response:', Array.from(statusData).map(b => b.toString(16).padStart(2, '0')).join(' '));
        
        // Parse paper information from status response
        const paperInfo = this.parsePaperInfo(statusData);
        console.log('Detected paper:', paperInfo);
        return paperInfo;
      } else {
        console.warn('Empty status response, printer may be busy');
        return null;
      }
    } catch (error) {
      console.warn('Status request failed, printer may be processing:', error);
      return null;
    }
  }

  private parsePaperInfo(statusData: Uint8Array): any {
    // Brother QL status byte layout (simplified)
    // Byte 10: Media type
    // Byte 11: Media width
    // Byte 17: Media length (for die-cut labels)
    
    if (!statusData || statusData.length < 18) {
      console.error('Invalid status data received:', statusData);
      return null;
    }
    
    const mediaType = statusData[10];
    const mediaWidth = statusData[11];
    const mediaLength = statusData[17];
    
    if (mediaType === undefined || mediaWidth === undefined || mediaLength === undefined) {
      console.error('Could not parse media info from status data');
      return null;
    }
    
    console.log(`Media type: 0x${mediaType.toString(16)}, Width: ${mediaWidth}mm, Length: ${mediaLength}mm`);
    
    // Calculate print dimensions based on width (at 180 DPI)
    const printWidth = Math.floor((mediaWidth * 180) / 25.4); // Convert mm to pixels
    const bytesPerLine = Math.ceil(printWidth / 8); // Convert pixels to bytes
    
    return {
      type: mediaType,
      width: mediaWidth,
      length: mediaLength,
      printWidth,
      bytesPerLine,
      isEndless: mediaLength === 0 // Endless tape vs die-cut labels
    };
  }

  async testPrint(): Promise<boolean> {
    if (!this.device || !this.isConnected) {
      throw new Error('Brother QL printer not connected');
    }

    try {
      console.log('Reading paper information from printer...');
      
      // First, get the paper info from the printer
      const paperInfo = await this.getStatus();
      
      if (!paperInfo) {
        console.log('Could not detect paper, using safe defaults...');
        return this.sendSimpleTestPrint();
      }

      console.log('Detected paper info:', paperInfo);
      console.log('Sending test print optimized for detected paper...');

      // Create print commands based on detected paper
      const testCommands: number[] = [
        // Initialize printer
        0x1B, 0x40, // ESC @ - Initialize printer
        
        // Switch to raster mode
        0x1B, 0x69, 0x52, 0x01,
        
        // Auto cut
        0x1B, 0x69, 0x4D, 0x40,
        
        // Set compression mode off
        0x1B, 0x69, 0x4B, 0x08,
      ];

      // Use detected paper dimensions for test pattern
      const labelHeight = paperInfo.isEndless ? 100 : Math.min(100, paperInfo.length * 7); // Conservative height
      const bytesPerLine = Math.min(paperInfo.bytesPerLine, 90); // Use detected width but cap it

      console.log(`Creating test pattern: ${labelHeight} lines x ${bytesPerLine} bytes per line`);

      // Add raster data for test pattern
      for (let line = 0; line < labelHeight; line++) {
        // Raster line command
        testCommands.push(0x67, 0x00, bytesPerLine);
        
        // Create a simple test pattern that shows the detected paper size
        for (let byte = 0; byte < bytesPerLine; byte++) {
          if (line < 3 || line >= labelHeight - 3 || byte < 2 || byte >= bytesPerLine - 2) {
            testCommands.push(0xFF); // Border to show full width/height
          } else if (line >= Math.floor(labelHeight/2) - 2 && line <= Math.floor(labelHeight/2) + 2) {
            testCommands.push(0xFF); // Center horizontal line
          } else {
            testCommands.push(0x00); // White background
          }
        }
      }

      // Print command
      testCommands.push(0x1A);

      // Convert to Uint8Array and send
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

  private async sendSimpleTestPrint(): Promise<boolean> {
    try {
      console.log('Sending Brother QL test print using official manual commands...');
      
      // Follow exact sequence from Brother QL-800 manual
      const testCommands: number[] = [];
      
      // 1. Invalidate command (400 bytes of 0x00)
      for (let i = 0; i < 400; i++) {
        testCommands.push(0x00);
      }
      
      // 2. Initialize
      testCommands.push(0x1B, 0x40);
      
      // 3. Switch dynamic command mode (enter raster mode)
      testCommands.push(0x1B, 0x69, 0x61, 0x01);
      
      // 4. Switch automatic status notification mode
      testCommands.push(0x1B, 0x69, 0x21, 0x00);
      
      // 5. Print information command for 12mm continuous tape
      testCommands.push(
        0x1B, 0x69, 0x7A,     // Print info command
        0x86,                 // Valid flag (media type + width + length + quality)
        0x0A,                 // Media type: continuous tape (0x0A)
        0x0C,                 // Media width: 12mm
        0x00,                 // Media length: 0 (continuous)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00  // Reserved bytes
      );
      
      // 6. Various mode (auto cut on)
      testCommands.push(0x1B, 0x69, 0x4D, 0x40);
      
      // 7. Specify page number for auto cut (cut each 1 label)
      testCommands.push(0x1B, 0x69, 0x41, 0x01);
      
      // 8. Expanded mode (cut at end)
      testCommands.push(0x1B, 0x69, 0x4B, 0x08);
      
      // 9. Specify margin amount (3mm = 35 dots)
      testCommands.push(0x1B, 0x69, 0x64, 0x23, 0x00);
      
      // 10. Select compression mode (no compression)
      testCommands.push(0x4D, 0x00);
      
      // 11. Send raster data (create 30 lines for a small test label)
      for (let line = 0; line < 30; line++) {
        // Raster graphics transfer command
        testCommands.push(0x67, 0x00, 0x5A); // 90 bytes per line (720 pins / 8)
        
        // Create test pattern - simple border with "TEST" pattern
        for (let byte = 0; byte < 90; byte++) {
          if (line < 2 || line >= 28) {
            // Top/bottom border
            testCommands.push(0xFF);
          } else if (byte < 2 || byte >= 88) {
            // Left/right border  
            testCommands.push(0xFF);
          } else if (line >= 10 && line <= 20 && byte >= 30 && byte <= 60) {
            // Center "TEST" block
            testCommands.push(line % 2 === 0 ? 0xAA : 0x55);
          } else {
            // Background
            testCommands.push(0x00);
          }
        }
      }
      
      // 12. Print command with feeding (end of page)
      testCommands.push(0x1A);

      console.log('Sending', testCommands.length, 'bytes following official Brother manual...');
      const uint8Data = new Uint8Array(testCommands);
      const result = await this.device.transferOut(this.outEndpoint, uint8Data.buffer);
      
      if (result.status === 'ok') {
        console.log('Official Brother QL commands sent - should print and cut automatically');
        return true;
      } else {
        console.error('Failed to send official commands:', result.status);
        return false;
      }
      
    } catch (error) {
      console.error('Official Brother QL test print failed:', error);
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
