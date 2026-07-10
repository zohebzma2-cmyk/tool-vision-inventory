// Client-side label printing for Brother label printers.
//
// Renders a LabelTemplate to a monochrome raster and prints it directly over WebUSB (any Brother
// device — QL roll printers today; PT/P-touch tape printers use the same raster path). This lets us
// print the app's custom templates entirely in the browser, without the Supabase edge function.
//
// NOTE: raster output targets Brother QL raster commands (reused from utils/brotherQL). Hardware
// print behaviour must be verified on a physical printer; the render + encode path is unit-safe.

import QRCode from "qrcode";
import { BrotherQLRaster } from "@/utils/brotherQL";
import { renderTokens, type LabelTemplate, type LabelData } from "./labelTemplates";
import { printerService, isPrintingSupported } from "@/components/inventory/PrinterService";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Render a template + data to a monochrome canvas at the printer's dot width. */
export async function rasterizeTemplate(
  template: LabelTemplate,
  data: LabelData,
  dotsWide = 696,
): Promise<HTMLCanvasElement> {
  const aspect = (template.heightMm || 24) / (template.widthMm || 62);
  const W = dotsWide;
  const H = Math.max(1, Math.round(W * aspect));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not available");

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, W, H);

  for (const el of template.elements) {
    const x = (el.x / 100) * W;
    const y = (el.y / 100) * H;
    const w = (el.w / 100) * W;
    const h = (el.h / 100) * H;

    if (el.type === "qr") {
      const val = data.qr || "";
      if (!val) continue;
      const url = await QRCode.toDataURL(val, { margin: 0, scale: 8 });
      const img = await loadImage(url);
      ctx.drawImage(img, x, y, w, h);
    } else {
      const text = renderTokens(el.value ?? "", data);
      const fontSize = Math.max(8, h * 0.72 * (el.fontScale ?? 1));
      // Single-color raster: red elements print as black (color separation is QL two-color only).
      ctx.fillStyle = "black";
      ctx.font = `${el.bold ? "bold " : ""}${Math.round(fontSize)}px Helvetica, Arial, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = el.align === "center" ? "center" : el.align === "right" ? "right" : "left";
      const tx = el.align === "center" ? x + w / 2 : el.align === "right" ? x + w : x;
      ctx.fillText(text, tx, y + h / 2);
    }
  }
  return canvas;
}

/** Convert a rendered canvas into a Brother QL black-raster print job. */
export function canvasToQLJob(canvas: HTMLCanvasElement, widthMm = 62): number[] {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not available");
  const { width: W, height: H } = canvas;
  const img = ctx.getImageData(0, 0, W, H).data;
  const bytesPerLine = Math.ceil(W / 8);

  const qlr = new BrotherQLRaster("QL-800");
  qlr.initialize();
  qlr.setStatus();
  qlr.setAutoCut(true);
  qlr.setMargin(35);
  qlr.setMedia(widthMm, 0, H, true);
  qlr.enterRasterMode();
  qlr.setFeedAmount(1);

  for (let y = 0; y < H; y++) {
    const line = new Array(bytesPerLine).fill(0);
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const lum = img[idx] * 0.299 + img[idx + 1] * 0.587 + img[idx + 2] * 0.114;
      const alpha = img[idx + 3];
      if (alpha > 128 && lum < 128) line[x >> 3] |= 0x80 >> (x & 7);
    }
    qlr.addRasterLine(line);
  }
  qlr.print();
  return qlr.getData();
}

/** Render + print one label from a template. Connects to a Brother printer on demand. */
export async function printTemplateLabel(
  template: LabelTemplate,
  data: LabelData,
): Promise<{ success: boolean; message: string }> {
  if (!isPrintingSupported()) {
    return { success: false, message: "Printing needs a Chromium browser (WebUSB)." };
  }
  if (!printerService.isConnected) {
    const ok = await printerService.connect();
    if (!ok) return { success: false, message: "Could not connect to a Brother printer." };
  }
  try {
    const canvas = await rasterizeTemplate(template, data, 696);
    const job = canvasToQLJob(canvas, 62);
    const ok = await printerService.print(job);
    return ok
      ? { success: true, message: "Label sent to printer." }
      : { success: false, message: "Printer transfer failed." };
  } catch (e) {
    return { success: false, message: `Print failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
