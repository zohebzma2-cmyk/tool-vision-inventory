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

import QRCode from 'qrcode';
import { createBrotherQLPrintJob, BrotherQLRaster } from '../../utils/brotherQL';

class BrotherQLPrinterService implements PrinterService {
  private device: USBDevice | null = null;
  private outEndpoint: number = 2;
  private inEndpoint: number = 1;
  public isConnected = false;
  private lastPaperInfo: any = null;

  async connect(): Promise<boolean> {
    try {
      // Check if WebUSB API is supported
      if (!('usb' in navigator)) {
        throw new Error('WebUSB API not supported in this browser. Please use Chrome, Edge, or another Chromium-based browser.');
      }

      console.log('Requesting Brother QL printer connection via WebUSB...');

      // Request any Brother label printer (QL roll series + PT/P-touch tape series).
      // Vendor-only filter matches every Brother device so users aren't limited to QL-800.
      this.device = await (navigator as any).usb.requestDevice({
        filters: [
          { vendorId: 0x04f9 }, // any Brother device
        ],
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
      
      // Send data in chunks to avoid transfer size limits (like working implementation)
      const CHUNK_SIZE = 16 * 1024; // 16KB chunks
      
      for (let offset = 0; offset < uint8Data.length; offset += CHUNK_SIZE) {
        // Send the VIEW, not chunk.buffer — subarray shares the full underlying ArrayBuffer, so
        // chunk.buffer would re-send the entire job from offset 0 on every iteration (double print
        // / stall for any label bigger than CHUNK_SIZE). A Uint8Array is a valid BufferSource.
        const chunk = uint8Data.subarray(offset, Math.min(offset + CHUNK_SIZE, uint8Data.length));
        const result = await this.device.transferOut(this.outEndpoint, chunk);

        if (result.status !== 'ok') {
          console.error('Print transfer failed with status:', result.status);
          return false;
        }
      }
      
      console.log('Print data sent successfully via WebUSB');
      return true;

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

      const readOnce = async () => {
        await this.device!.transferOut(this.outEndpoint, statusRequest.buffer);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const res = await this.device!.transferIn(this.inEndpoint, 32);
        const data = res.status === 'ok' && res.data?.byteLength ? new Uint8Array(res.data.buffer) : new Uint8Array();
        return { res, data } as const;
      };

      // First read
      let { res, data } = await readOnce();

      // Retry once if empty/short
      if (data.length < 32) {
        console.warn('Empty/short status response; retrying...');
        await new Promise((resolve) => setTimeout(resolve, 250));
        ({ res, data } = await readOnce());
      }

      if (res.status === 'ok' && data.length >= 32) {
        console.log('Status response:', Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '));
        // Decode status/error flags for diagnostics
        const decoded = this.decodeStatus(data);
        if (decoded.errors.length) {
          console.warn('Printer errors:', decoded.errors.join(', '));
        } else {
          console.log(`Printer OK. Status: ${decoded.statusType}, Phase: ${decoded.phaseType}`);
        }
        // Parse paper information from status response
        const paperInfo = this.parsePaperInfo(data);
        console.log('Detected paper:', paperInfo);
        if (paperInfo) this.lastPaperInfo = paperInfo;
        return paperInfo;
      }

      console.warn('No valid status received; using last known media if available.');
      if (this.lastPaperInfo) return this.lastPaperInfo;
      return null;
    } catch (error) {
      console.error('Failed to get printer status:', error);
      return this.lastPaperInfo ?? null;
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
      console.log('Creating test print using Brother QL library...');
      
      // Use the new Brother QL library to create print commands
      const printCommands = createBrotherQLPrintJob({
        text: 'TEST',
        labelSize: '62red',
        twoColor: true,
        fontSize: 70,
        width: 696,
        height: 100
      });

      console.log('Generated', printCommands.length, 'bytes using Brother QL library');
      
      const uint8Data = new Uint8Array(printCommands);
      const result = await this.device.transferOut(this.outEndpoint, uint8Data.buffer);
      
      if (result.status === 'ok') {
        console.log('Brother QL test print sent successfully');
        return true;
      } else {
        console.error('Test print failed with status:', result.status);
        return false;
      }

    } catch (error) {
      console.error('Failed to send Brother QL test print:', error);
      return false;
    }
  }

  async testPrintTwoColor(): Promise<boolean> {
    if (!this.device || !this.isConnected) {
      throw new Error('Brother QL printer not connected');
    }

    try {
      console.log('Creating two-color test using Brother QL library...');

      // Create a more sophisticated two-color test
      const qlr = new BrotherQLRaster('QL-800');
      const printCommands = qlr.createTextLabel('DEMO', {
        labelSize: '62red',
        fontSize: 80,
        twoColor: true,
        width: 696,
        height: 120
      });

      console.log('Generated', printCommands.length, 'bytes for two-color test');

      const data = new Uint8Array(printCommands);
      const result = await this.device.transferOut(this.outEndpoint, data.buffer);
      
      if (result.status === 'ok') {
        console.log('Brother QL two-color test sent successfully');
        return true;
      } else {
        console.error('Two-color test failed with status:', result.status);
        return false;
      }
    } catch (error) {
      console.error('Brother QL two-color test failed:', error);
      return false;
    }
  }

  async testPrintWordRed(word: string = 'TEST'): Promise<boolean> {
    if (!this.device || !this.isConnected) {
      throw new Error('Brother QL printer not connected');
    }

    try {
      console.log(`Creating red "${word}" print using Brother QL library...`);

      const printCommands = createBrotherQLPrintJob({
        text: word,
        labelSize: '62red', 
        twoColor: true,
        fontSize: 70,
        width: 696,
        height: 96
      });

      console.log('Generated', printCommands.length, 'bytes for red word print');

      const data = new Uint8Array(printCommands);
      const result = await this.device.transferOut(this.outEndpoint, data.buffer);
      
      if (result.status === 'ok') {
        console.log('Brother QL red word print sent successfully');
        return true;
      } else {
        console.error('Red word print failed with status:', result.status);
        return false;
      }
    } catch (error) {
      console.error('Brother QL red word print failed:', error);
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

const LABEL_FONT = 'Barlow, "Helvetica Neue", Arial, sans-serif';

/** Trim + ellipsize `text` so it fits `maxW` at the ctx's current font. */
function ellipsizeCtx(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/**
 * Fit a title into a box `maxW` wide: pick the largest font (maxPx..minPx) at which it fits
 * on one line, or wraps cleanly onto two. Falls back to a single ellipsized line at minPx.
 */
function fitTitle(ctx: CanvasRenderingContext2D, title: string, maxW: number, maxPx: number, minPx: number): { px: number; lines: string[] } {
  const words = title.split(/\s+/).filter(Boolean);
  for (let px = maxPx; px >= minPx; px -= 2) {
    ctx.font = `700 ${px}px ${LABEL_FONT}`;
    if (ctx.measureText(title).width <= maxW) return { px, lines: [title] };
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      if (ctx.measureText(a).width <= maxW && ctx.measureText(b).width <= maxW) return { px, lines: [a, b] };
    }
  }
  ctx.font = `700 ${minPx}px ${LABEL_FONT}`;
  return { px: minPx, lines: [ellipsizeCtx(ctx, title, maxW)] };
}

export interface LabelSpec {
  /** Big, high-legibility code shown first (e.g. "BIN 12") — for grab-from-a-distance reading. */
  badge?: string;
  /** Primary name. */
  title: string;
  /** Secondary detail lines. */
  lines?: string[];
  /** QR payload (rendered on the left). */
  qr?: string;
}

/** Load a QR payload into an <img> (or null if none / it fails). */
async function loadQrImage(qr?: string): Promise<HTMLImageElement | null> {
  if (!qr) return null;
  try {
    const url = await QRCode.toDataURL(qr, { margin: 0, scale: 8 });
    return await new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url;
    });
  } catch {
    return null;
  }
}

/**
 * Render a clean label to a canvas sized for a 62 mm Brother label: an optional QR on the left,
 * an optional big badge (e.g. a bin number), a bold auto-fit title (wrapping to two lines when
 * long) and detail lines — the whole text block vertically centered so there's no dead space or
 * overlap. Every line auto-fits its column width, so nothing ever runs into the QR.
 */
async function rasterizeLabel(spec: LabelSpec): Promise<HTMLCanvasElement> {
  const title = (spec.title || 'Label').trim();
  const details = (spec.lines ?? []).map((l) => l.trim()).filter(Boolean);
  const badge = spec.badge?.trim();

  const W = 696; // 62 mm @ ~300 dpi
  const pad = 48;
  const gap = 30; // between QR and text

  const qrImg = await loadQrImage(spec.qr);
  const qrSize = 220;
  const textX = pad + (qrImg ? qrSize + gap : 0);
  const textW = W - textX - pad;

  const meas = document.createElement('canvas').getContext('2d')!;

  // Badge: as large as fits on one line, up to 96px.
  let badgePx = 0, badgeLineH = 0, badgeText = '';
  if (badge) {
    badgePx = 96;
    meas.font = `800 ${badgePx}px ${LABEL_FONT}`;
    while (badgePx > 46 && meas.measureText(badge).width > textW) {
      badgePx -= 2;
      meas.font = `800 ${badgePx}px ${LABEL_FONT}`;
    }
    badgeText = ellipsizeCtx(meas, badge, textW);
    badgeLineH = Math.round(badgePx * 1.04);
  }

  const fit = fitTitle(meas, title, textW, badge ? 48 : 66, 30);
  const titleLineH = Math.round(fit.px * 1.16);
  const detailPx = 36;
  const detailLineH = 48;
  meas.font = `400 ${detailPx}px ${LABEL_FONT}`;
  const detailLines = details.map((d) => ellipsizeCtx(meas, d, textW));

  const blockH =
    (badge ? badgeLineH + 8 : 0) +
    fit.lines.length * titleLineH +
    (detailLines.length ? 12 + detailLines.length * detailLineH : 0);
  const H = Math.max(qrImg ? qrSize + pad * 2 : 190, blockH + pad * 2);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);

  if (qrImg) ctx.drawImage(qrImg, pad, Math.round((H - qrSize) / 2), qrSize, qrSize);

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  let cy = Math.round((H - blockH) / 2); // top of the centered text block
  if (badge) {
    ctx.fillStyle = '#111111';
    ctx.font = `800 ${badgePx}px ${LABEL_FONT}`;
    ctx.fillText(badgeText, textX, cy + badgeLineH / 2);
    cy += badgeLineH + 8;
  }
  ctx.fillStyle = '#111111';
  ctx.font = `700 ${fit.px}px ${LABEL_FONT}`;
  for (const line of fit.lines) {
    ctx.fillText(line, textX, cy + titleLineH / 2);
    cy += titleLineH;
  }
  if (detailLines.length) {
    cy += 12;
    ctx.fillStyle = '#444444';
    ctx.font = `400 ${detailPx}px ${LABEL_FONT}`;
    for (const line of detailLines) {
      ctx.fillText(line, textX, cy + detailLineH / 2);
      cy += detailLineH;
    }
  }
  return canvas;
}

// Print an arbitrary text label. WebUSB (desktop Brother QL) when available; on iOS/other browsers
// with no WebUSB, render to an image and hand it to the system share sheet (AirPrint / Brother
// iPrint&Label) — so the same button works on the phone where WebUSB doesn't exist.
/**
 * Pack a rendered label canvas into a Brother QL raster job (uncompressed black), one raster line
 * per canvas row. The canvas is 696 px wide to match a 62 mm continuous label's print area, so the
 * clean on-screen design is exactly what the laptop printer lays down.
 */
function canvasToRasterJob(canvas: HTMLCanvasElement): number[] {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  const px = ctx.getImageData(0, 0, W, H).data;
  const bytesPerLine = Math.ceil(W / 8); // 87 for 696 dots

  const qlr = new BrotherQLRaster('QL-800');
  qlr.clear();
  qlr.initialize();
  qlr.setStatus();
  qlr.setTwoColorMode(false);
  qlr.setAutoCut(true);
  qlr.setMargin(35); // ~3 mm
  qlr.enterRasterMode();
  qlr.setFeedAmount(1);

  for (let y = 0; y < H; y++) {
    const line = new Array(bytesPerLine).fill(0);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      // Opaque + dark → a black dot; MSB is the left-most pixel of the byte.
      if (px[i + 3] > 128 && lum < 128) line[x >> 3] |= 0x80 >> (x & 7);
    }
    qlr.addRasterLine(line);
  }
  qlr.print();
  return qlr.getData();
}

export async function printLabel(spec: LabelSpec): Promise<{ success: boolean; message: string }> {
  const heading = spec.badge ? `${spec.badge} · ${spec.title}` : spec.title;
  try {
    if (isPrintingSupported()) {
      // Laptop Brother QL over WebUSB: raster the exact clean label canvas (QR + badge + text).
      if (!printerService.isConnected) {
        const connected = await printerService.connect();
        if (!connected) return { success: false, message: 'Couldn\'t reach the Brother printer — make sure it\'s on, plugged in via USB, and Brother\'s own P-touch/QL software is closed, then try again.' };
      }
      const canvas = await rasterizeLabel(spec);
      const ok = await printerService.print(canvasToRasterJob(canvas));
      return ok
        ? { success: true, message: `Printed label: ${heading}` }
        : { success: false, message: 'Failed to send data to printer.' };
    }

    // No WebUSB (iOS / Safari): share or download a label image.
    const canvas = await rasterizeLabel(spec);
    const blob: Blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't render label"))), 'image/png'),
    );
    const fileBase = (spec.badge || spec.title || 'label').replace(/[^\w-]+/g, '_');
    const file = new File([blob], `${fileBase}.png`, { type: 'image/png' });
    if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: heading });
      return { success: true, message: 'Label sent to the share sheet — pick Print or your Brother app.' };
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.click();
    URL.revokeObjectURL(url);
    return { success: true, message: 'Label image downloaded.' };
  } catch (e) {
    // User dismissed the share sheet — not a success ("Label sent" would be a lie) and not an error.
    if ((e as Error)?.name === 'AbortError') return { success: false, message: 'Print canceled.' };
    return { success: false, message: `Print failed: ${e instanceof Error ? e.message : 'Unknown error'}` };
  }
}

/** Back-compat: a plain multi-line text label (first line = title). */
export async function printTextLabel(text: string, qr?: string): Promise<{ success: boolean; message: string }> {
  const parts = text.split('\n').map((s) => s.trim()).filter(Boolean);
  return printLabel({ title: parts[0] ?? 'Label', lines: parts.slice(1), qr });
}

