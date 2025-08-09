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
          
          // Interface claimed successfully
          
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

      // Test different endpoint configurations
      let endpointFound = false;
      const endpointConfigs = [
        { out: 1, in: 1 },
        { out: 2, in: 1 },
        { out: 1, in: 2 },
        { out: 3, in: 2 }
      ];

      for (const config of endpointConfigs) {
        try {
          // Test endpoint by sending a simple status request
          const testData = new Uint8Array([0x1B, 0x69, 0x53]); // Status request command
          const result = await this.device.transferOut(config.out, testData.buffer);
          
          if (result.status === 'ok') {
            this.outEndpoint = config.out;
            this.inEndpoint = config.in;
            console.log(`Working endpoints found - OUT: ${this.outEndpoint}, IN: ${this.inEndpoint}`);
            endpointFound = true;
            break;
          }
        } catch (error) {
          console.log(`Endpoint ${config.out}/${config.in} test failed:`, error);
        }
      }

      if (!endpointFound) {
        console.warn('Could not find working endpoints, using defaults');
        this.outEndpoint = 1;
        this.inEndpoint = 1;
      }

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
    
    const status0 = statusData[0];
    const mediaType = statusData[10];
    const mediaWidth = statusData[11];
    const mediaLength = statusData[17];
    
    // Decode error status
    const errors = [];
    if (status0 & 0x01) errors.push('Replace media');
    if (status0 & 0x02) errors.push('Expansion buffer full');
    if (status0 & 0x04) errors.push('Communication error');
    if (status0 & 0x08) errors.push('Transmission error');
    if (status0 & 0x10) errors.push('Cover open');
    if (status0 & 0x20) errors.push('Cancel key');
    if (status0 & 0x40) errors.push('Media cannot be fed');
    if (status0 & 0x80) errors.push('System error');
    
    if (errors.length > 0) {
      console.error('🚨 PRINTER ERRORS:', errors.join(', '));
      console.error('Status byte 0:', status0.toString(16));
    }
    
    // Decode media width
    const widthMappings = {
      0x04: '6mm',
      0x06: '9mm', 
      0x08: '12mm',
      0x0A: '10mm (continuous)',
      0x0C: '12mm',
      0x11: '17mm',
      0x17: '23mm',
      0x3E: '62mm'
    };
    
    const widthText = widthMappings[mediaWidth] || `${mediaWidth}mm (unknown)`;
    
    console.log('📏 DETECTED PAPER:', {
      'Media Type': `0x${mediaType.toString(16)} (${mediaType === 0x3E ? 'Continuous tape' : 'Unknown'})`,
      'Width': widthText,
      'Length': mediaLength === 0 ? 'Continuous' : `${mediaLength}mm`,
      'Raw Width Code': `0x${mediaWidth.toString(16)}`,
      'Errors': errors.length > 0 ? errors : 'None'
    });
    
    if (mediaType === undefined || mediaWidth === undefined || mediaLength === undefined) {
      console.error('Could not parse media info from status data');
      return null;
    }
    
    // Calculate print dimensions based on width (at 180 DPI)
    const printWidth = Math.floor((mediaWidth * 180) / 25.4); // Convert mm to pixels
    const bytesPerLine = Math.ceil(printWidth / 8); // Convert pixels to bytes
    
    return {
      type: mediaType,
      width: mediaWidth,
      length: mediaLength,
      printWidth,
      bytesPerLine,
      isEndless: mediaLength === 0, // Endless tape vs die-cut labels
      errors: errors,
      hasErrors: errors.length > 0,
      widthText: widthText
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
      console.log('Attempting comprehensive Brother QL printer reset and test...');
      
      // First, try to clear any error states
      try {
        console.log('Sending error clear commands...');
        
        // Clear errors and reset printer
        const clearCommands = new Uint8Array([
          0x1B, 0x40, // Initialize - clear all settings
          0x1B, 0x69, 0x21, 0x00, // Clear status notification
          0x1B, 0x69, 0x4B, 0x08, // Clear expanded mode
        ]);
        await this.device.transferOut(this.outEndpoint, clearCommands.buffer);
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Request status to see current state
        const statusRequest = new Uint8Array([0x1B, 0x69, 0x53]);
        await this.device.transferOut(this.outEndpoint, statusRequest.buffer);
        await new Promise(resolve => setTimeout(resolve, 300));
        
        const statusResult = await this.device.transferIn(this.inEndpoint, 32);
        if (statusResult.status === 'ok' && statusResult.data.byteLength > 0) {
          const statusData = new Uint8Array(statusResult.data.buffer);
          console.log('Current printer status:', Array.from(statusData).map(b => b.toString(16).padStart(2, '0')).join(' '));
          
          // Decode status byte 0 for errors
          const status0 = statusData[0];
          const errors = [];
          if (status0 & 0x01) errors.push('Replace media');
          if (status0 & 0x02) errors.push('Expansion buffer full');
          if (status0 & 0x04) errors.push('Communication error');
          if (status0 & 0x08) errors.push('Transmission error');
          if (status0 & 0x10) errors.push('Cover open');
          if (status0 & 0x20) errors.push('Cancel key');
          if (status0 & 0x40) errors.push('Media cannot be fed');
          if (status0 & 0x80) errors.push('System error');
          
          if (errors.length > 0) {
            console.log('PRINTER ERRORS DETECTED:', errors.join(', '));
            console.log('STATUS BYTE 0:', status0.toString(16));
          } else {
            console.log('No errors detected in status');
          }
          
          // Check if we have the exact paper info
          const mediaWidth = statusData[11];
          console.log('Detected media width:', mediaWidth, 'mm');
        }
        
      } catch (error) {
        console.log('Status check failed, continuing:', error);
      }

      console.log('Sending minimal test with proper media settings...');
      
      const testCommands: number[] = [];
      
      // 1. Initialize
      testCommands.push(0x1B, 0x40);
      
      // 2. Clear any error states
      testCommands.push(0x1B, 0x69, 0x21, 0x00); // Clear notifications
      
      // 3. Enter raster mode
      testCommands.push(0x1B, 0x69, 0x61, 0x01);
      
      // 4. Set media info for 10mm continuous tape (from detected status)
      testCommands.push(
        0x1B, 0x69, 0x7A,  // Print info command
        0x8F,              // All flags valid
        0x0A,              // Continuous tape
        0x0A,              // 10mm width (detected from status)
        0x00,              // Length 0 (continuous)
        0x00, 0x00, 0x00, 0x00 // Additional bytes
      );
      
      // 5. Set auto cut mode
      testCommands.push(0x1B, 0x69, 0x4D, 0x40);
      
      // 6. Set print quality and other modes
      testCommands.push(0x1B, 0x69, 0x4B, 0x08); // Expanded mode
      
      // 7. Set margin (minimal)
      testCommands.push(0x1B, 0x69, 0x64, 0x00, 0x00); // No margin
      
      // 8. Send minimal raster data for 10mm tape (approximately 8 bytes per line)
      for (let line = 0; line < 5; line++) {
        testCommands.push(0x67, 0x00, 0x08); // Raster line, 8 bytes
        
        // Simple test pattern
        for (let byte = 0; byte < 8; byte++) {
          testCommands.push(0xFF); // All black dots
        }
      }
      
      // 9. Print and cut
      testCommands.push(0x1A);

      console.log('Sending optimized test for 10mm tape:', testCommands.length, 'bytes');
      
      const uint8Data = new Uint8Array(testCommands);
      const result = await this.device.transferOut(this.outEndpoint, uint8Data.buffer);
      
      if (result.status === 'ok') {
        console.log('Optimized test sent successfully - bytes written:', result.bytesWritten);
        console.log('Check printer for a small black rectangle label...');
        
        // Wait for print to complete
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        return true;
      } else {
        console.error('Optimized test failed with status:', result.status);
        return false;
      }
      
    } catch (error) {
      console.error('Comprehensive test failed:', error);
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
    console.log('Print data length:', result.printData.length, 'bytes');
    console.log('First 20 bytes:', result.printData.slice(0, 20));
    console.log('Last 10 bytes:', result.printData.slice(-10));

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
