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
      console.log('Requesting printer status...');
      // Request status information
      const statusRequest = new Uint8Array([0x1B, 0x69, 0x53]);
      await this.device.transferOut(this.outEndpoint, statusRequest.buffer);
      
      // Add delay for printer to process
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Read status response (Brother QL returns 32 bytes)
      const result = await this.device.transferIn(this.inEndpoint, 32);
      
      if (result.status === 'ok') {
        const statusData = new Uint8Array(result.data.buffer);
        console.log('Status response:', Array.from(statusData).map(b => b.toString(16).padStart(2, '0')).join(' '));
        // Decode status/error flags for diagnostics
        const decoded = this.decodeStatus(statusData);
        if (decoded.errors.length) {
          console.warn('Printer errors:', decoded.errors.join(', '));
        } else {
          console.log(`Printer OK. Status: ${decoded.statusType}, Phase: ${decoded.phaseType}`);
        }
        
        // Parse paper information from status response
        const paperInfo = this.parsePaperInfo(statusData);
        console.log('Detected paper:', paperInfo);
        return paperInfo;
      } else {
        console.error('Failed to read status:', result.status);
        return null;
      }
    } catch (error) {
      console.error('Failed to get printer status:', error);
      return null;
    }
  }

  private parsePaperInfo(statusData: Uint8Array): any {
    // Brother QL status byte layout (per Command Reference)
    // Byte 10: Media width (mm)
    // Byte 11: Media type (0x0A: Continuous, 0x0B: Die-cut)
    // Byte 17: Media length (mm for die-cut, 0 for continuous)
    
    if (!statusData || statusData.length < 32) {
      console.error('Invalid status data received:', statusData);
      return null;
    }
    
    const mediaWidthMm = statusData[10];
    const mediaTypeVal = statusData[11];
    const mediaLengthMm = statusData[17];
    
    if (mediaWidthMm === undefined || mediaTypeVal === undefined || mediaLengthMm === undefined) {
      console.error('Could not parse media info from status data');
      return null;
    }
    
    const mediaTypeLabel =
      mediaTypeVal === 0x0A ? 'Continuous length tape' :
      mediaTypeVal === 0x0B ? 'Die-cut label' :
      `Unknown (0x${mediaTypeVal.toString(16)})`;
    
    console.log(`Media type: ${mediaTypeLabel} (0x${mediaTypeVal.toString(16)}), Width: ${mediaWidthMm}mm, Length: ${mediaLengthMm === 0 ? 'Continuous' : mediaLengthMm + 'mm'}`);
    
    // Compute print area width in dots (62mm known to be 696 dots at 300dpi)
    const printWidth =
      mediaWidthMm === 62 ? 696 : Math.round((mediaWidthMm / 25.4) * 300);

    // Bytes per raster line based on print width
    const bytesPerLine = Math.ceil(printWidth / 8);
    
    return {
      type: mediaTypeVal,
      width: mediaWidthMm,
      length: mediaLengthMm,
      printWidth,
      bytesPerLine,
      isEndless: mediaTypeVal === 0x0A
    };
  }

  // Decode error/status flags from 32‑byte status response
  private decodeStatus(statusData: Uint8Array) {
    const err1 = statusData[8] ?? 0;
    const err2 = statusData[9] ?? 0;
    const statusType = statusData[18] ?? 0;
    const phaseType = statusData[19] ?? 0;

    const ERR1: Record<number, string> = {
      0: 'No media when printing',
      1: 'End of media (die-cut size only)',
      2: 'Tape cutter jam',
      3: 'Not used',
      4: 'Main unit in use',
      5: 'Printer turned off',
      6: 'High-voltage adapter (n/u)',
      7: 'Fan error',
    };
    const ERR2: Record<number, string> = {
      0: 'Replace media error',
      1: 'Expansion buffer full',
      2: 'Transmission/Communication error',
      3: 'Communication buffer full (n/u)',
      4: 'Cover opened while printing',
      5: 'Cancel key (n/u)',
      6: 'Media cannot be fed',
      7: 'System error',
    };

    const errors: string[] = [];
    for (let bit = 0; bit < 8; bit++) {
      if (err1 & (1 << bit)) errors.push(ERR1[bit] ?? `Err1 bit${bit}`);
      if (err2 & (1 << bit)) errors.push(ERR2[bit] ?? `Err2 bit${bit}`);
    }

    const STATUS: Record<number, string> = {
      0x00: 'Reply to status request',
      0x01: 'Printing completed',
      0x02: 'Error occurred',
      0x05: 'Notification',
      0x06: 'Phase change',
    };
    const PHASE: Record<number, string> = {
      0x00: 'Waiting to receive',
      0x01: 'Printing state',
    };

    return {
      errors,
      statusType: STATUS[statusType] ?? `Unknown (0x${statusType.toString(16)})`,
      phaseType: PHASE[phaseType] ?? `Unknown (0x${phaseType.toString(16)})`,
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
        0x1B, 0x40,

        // Enable automatic status notifications
        0x1B, 0x69, 0x21, 0x01,

        // Auto cut ON (Set each mode)
        0x1B, 0x69, 0x4D, 0x40,

        // Set margin amount to ~3mm (35 dots)
        0x1B, 0x69, 0x64, 0x23, 0x00,

        // Ensure black-only (disable two-color)
        0x1B, 0x69, 0x4B, 0x00,
      ];

      // Rely on printer's installed roll (auto media). Avoid ESC i z to prevent malformed params.

      // Set feed amount every label (small feed)
      testCommands.push(0x1B, 0x69, 0x41, 0x01);

      // Use detected paper dimensions for test pattern
      const labelHeight = paperInfo.isEndless ? 100 : Math.min(100, paperInfo.length * 7); // Conservative height
      const bytesPerLine = paperInfo.bytesPerLine ?? Math.ceil((paperInfo.printWidth ?? 696) / 8);

      // Provide explicit print information (media + raster lines) then switch to raster mode
      const widthByte = Math.max(0, Math.min(255, paperInfo.width ?? 62));
      const rasterLines = labelHeight;
      testCommands.push(
        0x1B, 0x69, 0x7A, // ESC i z
        0x4A,             // n1 flags
        0x0A,             // n2 media type: continuous
        widthByte,        // n3 width in mm
        0x00,             // n4 length mm (0 for continuous)
        rasterLines & 0xFF, (rasterLines >> 8) & 0xFF, 0x00, 0x00, // n5-n8 raster lines (LE)
        0x00, 0x00        // n9-n10 reserved
      );

      // Switch to raster mode
      testCommands.push(0x1B, 0x69, 0x52, 0x01);

      console.log(`Creating test pattern: ${labelHeight} lines x ${bytesPerLine} bytes per line`);

      // Add raster data for test pattern (uncompressed)
      for (let line = 0; line < labelHeight; line++) {
        // Raster line header: 0x67 (black, uncompressed), 0x00 (no compression), little-endian length
        testCommands.push(0x67, 0x00, bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF);
        
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
      console.log('Sending official Brother QL raster test (62mm)...');
      
      const testCommands: number[] = [
        // Initialize
        0x1B, 0x40,

        // Enable automatic status notifications
        0x1B, 0x69, 0x21, 0x01,

        // Set each mode: Auto cut ON (bit 6)
        0x1B, 0x69, 0x4D, 0x40,

        // Set margin amount to ~3mm (35 dots)
        0x1B, 0x69, 0x64, 0x23, 0x00,

        // Switch to raster mode
        0x1B, 0x69, 0x52, 0x01,
      ];

      // Send 60 raster lines, 87 bytes per line (696 dots @ 62mm)
      const bytesPerLine = 87;
      for (let line = 0; line < 60; line++) {
        // 0x67 (uncompressed), 0x00 (no compression), length LSB/MSB
        testCommands.push(0x67, 0x00, bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF);

        for (let byte = 0; byte < bytesPerLine; byte++) {
          // Visible pattern: frame + center band
          const topBottomBorder = line < 4 || line >= 56;
          const sideBorder = byte < 2 || byte >= bytesPerLine - 2;
          const centerBand = line >= 26 && line <= 34 && byte >= 10 && byte <= bytesPerLine - 7;

          if (topBottomBorder || sideBorder || centerBand) {
            testCommands.push(0xFF);
          } else {
            testCommands.push(0x00);
          }
        }
      }

       testCommands.push(0x1A);

      console.log('Sending', testCommands.length, 'bytes to printer...');
      const uint8Data = new Uint8Array(testCommands);
      const result = await this.device.transferOut(this.outEndpoint, uint8Data.buffer);
      
      if (result.status === 'ok') {
        console.log('Test print commands sent successfully - printer should feed and cut (auto cut).');
        return true;
      } else {
        console.error('Failed to send test print:', result.status);
        return false;
      }
      
    } catch (error) {
      console.error('Test print failed:', error);
      return false;
    }
  }

  async testPrintTwoColor(): Promise<boolean> {
    if (!this.device || !this.isConnected) {
      throw new Error('Brother QL printer not connected');
    }

    try {
      console.log('Sending two-color DK-2251 raster test (62mm red/black)...');

      const bytesPerLine = 87; // 62mm printable width => 696 dots / 8 = 87 bytes
      const labelHeight = 80; // lines

      const cmds: number[] = [
        // Initialize
        0x1B, 0x40,
        // Enable automatic status notifications
        0x1B, 0x69, 0x21, 0x01,
        // Expanded mode: enable two-color (bit0)
        0x1B, 0x69, 0x4B, 0x01,
        // Auto cut ON (Set each mode)
        0x1B, 0x69, 0x4D, 0x40,
        // Margin ~3mm
        0x1B, 0x69, 0x64, 0x23, 0x00,
        // Set media & quality for 62mm continuous (DK-2251)
        0x1B, 0x69, 0x7A, 0x4A, 0x0A, 0x3E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // Raster mode
        0x1B, 0x69, 0x52, 0x01,
        // Feed amount per label
        0x1B, 0x69, 0x41, 0x01,
      ];

      // Generate per-line black and red planes
      for (let y = 0; y < labelHeight; y++) {
        // Black plane: draw border rectangle
        cmds.push(0x77, 0x01, bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF);
        for (let x = 0; x < bytesPerLine; x++) {
          const topBottom = y < 3 || y >= labelHeight - 3;
          const sides = x < 2 || x >= bytesPerLine - 2;
          cmds.push(topBottom || sides ? 0xFF : 0x00);
        }

        // Red plane: draw a solid red band in the middle
        cmds.push(0x77, 0x02, bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF);
        for (let x = 0; x < bytesPerLine; x++) {
          const inRedBand = y >= Math.floor(labelHeight / 2) - 8 && y <= Math.floor(labelHeight / 2) + 8;
          cmds.push(inRedBand ? 0xFF : 0x00);
        }
      }

       cmds.push(0x1A);

      const data = new Uint8Array(cmds);
      const result = await this.device.transferOut(this.outEndpoint, data.buffer);
      if (result.status === 'ok') {
        console.log('Two-color test sent successfully');
        return true;
      } else {
        console.error('Two-color test failed with status:', result.status);
        return false;
      }
    } catch (error) {
      console.error('Two-color test print failed:', error);
      return false;
    }
  }

  // Print a specific word in red on DK-2251 two-color tape
  async testPrintWordRed(word: string = 'TEST'): Promise<boolean> {
    if (!this.device || !this.isConnected) {
      throw new Error('Brother QL printer not connected');
    }

    try {
      const paperInfo = await this.getStatus();
      const bytesPerLine = paperInfo?.bytesPerLine ?? 87;
      const printWidthPx = bytesPerLine * 8;
      const labelHeight = 96; // lines

      const cmds: number[] = [
        0x1B, 0x40,
        0x1B, 0x69, 0x21, 0x01,
        0x1B, 0x69, 0x4B, 0x01,
        0x1B, 0x69, 0x4D, 0x40,
        0x1B, 0x69, 0x64, 0x23, 0x00,
        0x1B, 0x69, 0x7A, 0x4A, 0x0A, Math.max(0, Math.min(255, paperInfo?.width ?? 62)), 0x00,
        labelHeight & 0xFF, (labelHeight >> 8) & 0xFF, 0x00, 0x00,
        0x00, 0x00,
        0x1B, 0x69, 0x52, 0x01,
        0x1B, 0x69, 0x41, 0x01,
      ];

      // Simple 5x7 uppercase font for T,E,S
      const font: Record<string, number[]> = {
        'T': [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
        'E': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
        'S': [0b01111,0b10000,0b10000,0b01110,0b00001,0b00001,0b11110],
      };

      const scale = 8; // enlarge 5x7 -> 40x56 px per char
      const charW = 5 * scale;
      const charH = 7 * scale;
      const space = 1 * scale;
      const letters = word.toUpperCase().split('');
      const textWidth = letters.length * charW + Math.max(0, letters.length - 1) * space;
      const startX = Math.max(0, Math.floor((printWidthPx - textWidth) / 2));
      const startY = Math.max(0, Math.floor((labelHeight - charH) / 2));

      // Precompute red bitmap lines
      for (let y = 0; y < labelHeight; y++) {
        // Black plane: blank
        cmds.push(0x77, 0x01, bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF);
        for (let i = 0; i < bytesPerLine; i++) cmds.push(0x00);

        // Red plane
        cmds.push(0x77, 0x02, bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF);
        for (let byteIndex = 0; byteIndex < bytesPerLine; byteIndex++) {
          let b = 0;
          for (let bit = 0; bit < 8; bit++) {
            const x = byteIndex * 8 + (7 - bit); // MSB left
            let on = false;
            if (y >= startY && y < startY + charH && x >= startX && x < startX + textWidth) {
              const relX = x - startX;
              const relY = y - startY;
              const charIndex = Math.floor(relX / (charW + space));
              const withinCharX = relX - charIndex * (charW + space);
              if (charIndex >= 0 && charIndex < letters.length && withinCharX < charW) {
                const glyph = font[letters[charIndex]];
                if (glyph) {
                  const gx = Math.floor(withinCharX / scale);
                  const gy = Math.floor(relY / scale);
                  const colMask = 1 << (4 - gx); // 5 columns, MSB on left
                  on = (glyph[gy] & colMask) !== 0;
                }
              }
            }
            if (on) b |= (1 << bit);
          }
          cmds.push(b);
        }
      }

      cmds.push(0x1A);

      const data = new Uint8Array(cmds);
      const result = await this.device.transferOut(this.outEndpoint, data.buffer);
      if (result.status === 'ok') {
        console.log('Red word test sent successfully');
        return true;
      } else {
        console.error('Red word test failed with status:', result.status);
        return false;
      }
    } catch (error) {
      console.error('Red word test print failed:', error);
      return false;
    }
  }

  disconnect(): void {
    if (this.device) {
      try {
        const iface = (this.device as any).claimedInterface ?? 0;
        // Release the claimed interface if possible
        (this.device as any).releaseInterface?.(iface);
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
      body: { locationId, autoFormat: true, twoColor: true } // Request auto-format and two-color mode
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

    console.log('Sending red "TEST" print...');
    const printed = await (printerService as any).testPrintWordRed('TEST');
    
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

// Two-color DK-2251 test print (red/black)
export async function testPrintTwoColor(): Promise<{ success: boolean; message: string }> {
  try {
    if (!printerService.isConnected) {
      console.log('Printer not connected, attempting to connect...');
      const connected = await printerService.connect();
      if (!connected) {
        return { success: false, message: 'Failed to connect to Brother QL printer.' };
      }
    }
    const ok = await (printerService as any).testPrintTwoColor();
    if (ok) {
      return { success: true, message: 'Two-color test sent successfully!' };
    }
    return { success: false, message: 'Two-color test failed to send.' };
  } catch (e) {
    return { success: false, message: `Two-color test failed: ${e instanceof Error ? e.message : 'Unknown error'}` };
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
