// Web Serial API types
interface SerialPort {
  readonly readable: ReadableStream;
  readonly writable: WritableStream;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
}

interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  parity?: 'none' | 'even' | 'odd';
  stopBits?: number;
  flowControl?: 'none' | 'hardware';
}

interface PrinterService {
  isConnected: boolean;
  connect: () => Promise<boolean>;
  print: (data: number[]) => Promise<boolean>;
  disconnect: () => void;
}

class BrotherQLPrinterService implements PrinterService {
  private port: SerialPort | null = null;
  public isConnected = false;

  async connect(): Promise<boolean> {
    try {
      // Check if Web Serial API is supported
      if (!('serial' in navigator)) {
        throw new Error('Web Serial API not supported in this browser');
      }

      console.log('Requesting Brother QL printer connection...');

      // Request a port - try Brother-specific first, then any device
      try {
        this.port = await (navigator as any).serial.requestPort({
          filters: [
            { usbVendorId: 0x04f9 }, // Brother vendor ID
            { usbVendorId: 0x04F9 }, // Brother vendor ID (uppercase)
            { usbVendorId: 1273 },   // Brother vendor ID (decimal)
          ]
        });
      } catch (filterError) {
        console.log('Brother-specific filter failed, trying without filters...');
        // Fallback: let user choose any serial device
        this.port = await (navigator as any).serial.requestPort();
      }

      console.log('Printer port obtained, opening connection...');

      // Open the port with Brother QL-800 compatible settings
      await this.port.open({ 
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        flowControl: 'none'
      });

      this.isConnected = true;
      console.log('Successfully connected to Brother QL printer');
      return true;
    } catch (error) {
      console.error('Failed to connect to printer. Error details:', error);
      console.error('Make sure:');
      console.error('1. Brother QL-800 is connected via USB');
      console.error('2. Printer is powered on');
      console.error('3. You are using Chrome/Edge browser');
      console.error('4. The printer is not being used by another application');
      this.isConnected = false;
      return false;
    }
  }

  async print(data: number[]): Promise<boolean> {
    if (!this.port || !this.isConnected) {
      throw new Error('Printer not connected');
    }

    try {
      const writer = this.port.writable!.getWriter();
      const uint8Data = new Uint8Array(data);
      
      console.log('Sending print data to Brother QL printer:', uint8Data.length, 'bytes');
      await writer.write(uint8Data);
      writer.releaseLock();
      
      console.log('Print data sent successfully');
      return true;
    } catch (error) {
      console.error('Failed to print:', error);
      return false;
    }
  }

  disconnect(): void {
    if (this.port) {
      this.port.close();
      this.port = null;
      this.isConnected = false;
      console.log('Disconnected from printer');
    }
  }
}

// Singleton printer service
export const printerService = new BrotherQLPrinterService();

// Auto-print function using Supabase edge function
export async function autoPrintLabel(locationId: string): Promise<{ success: boolean; message: string }> {
  try {
    // Connect to printer if not already connected
    if (!printerService.isConnected) {
      const connected = await printerService.connect();
      if (!connected) {
        return {
          success: false,
          message: 'Failed to connect to Brother QL printer. Please ensure it\'s connected via USB and try again.'
        };
      }
    }

    // Get print data from the edge function using Supabase client
    const { supabase } = await import('@/integrations/supabase/client');
    
    const { data: result, error } = await supabase.functions.invoke('print-location-label', {
      body: { locationId }
    });

    if (error) {
      throw new Error(error.message || 'Failed to generate print data');
    }

    if (!result.success) {
      throw new Error(result.error || 'Failed to generate print data');
    }

    // Send print commands to printer
    const printed = await printerService.print(result.printData);
    
    if (printed) {
      return {
        success: true,
        message: `Label printed successfully for ${result.location.name}!`
      };
    } else {
      return {
        success: false,
        message: 'Failed to send data to printer'
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

// Browser compatibility check
export function isPrintingSupported(): boolean {
  return 'serial' in navigator;
}

// Manual printer connection for first-time setup
export async function setupPrinter(): Promise<boolean> {
  if (!isPrintingSupported()) {
    alert('Web Serial API is not supported in your browser. Please use Chrome, Edge, or another Chromium-based browser.');
    return false;
  }

  return await printerService.connect();
}