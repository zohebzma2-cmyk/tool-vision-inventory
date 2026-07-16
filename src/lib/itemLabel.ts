// In-app item label: the item name, up to two detail lines (category / brand / size), a scannable
// Code128 barcode for the USB 1D scanner, and the 5-char code. Rendered to a canvas at the loaded
// tape's width so Rapid Mode can print a matching label the instant an item is confirmed. Mirrors the
// bin label (src/lib/binLabel.ts) so items and bins read as one family on the wall.

import JsBarcode from "jsbarcode";
import { TAPE_PRESETS } from "@/lib/binLabel";

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxPx: number, weight = 700): number {
  let px = maxPx;
  for (; px > 12; px -= 2) {
    ctx.font = `${weight} ${px}px Barlow, Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return px;
}

/** Render an item label sized for `media` (defaults to the current tape). `sub` lines are optional. */
export function renderItemLabel(
  opts: { name: string; code: string; sub?: string[]; media?: string },
): HTMLCanvasElement {
  const preset = TAPE_PRESETS[opts.media || "62"] || TAPE_PRESETS["62"];
  const W = preset.w;
  const pad = Math.round(W * 0.05);
  const cx = W / 2;
  const subs = (opts.sub || []).filter((s) => s && s.trim()).slice(0, 2);

  // Measure on a scratch context first so we can size the canvas height to the content.
  const scratch = document.createElement("canvas").getContext("2d")!;
  const namePx = fitFont(scratch, opts.name, W - pad * 2, Math.round(W * 0.11), 800);
  const subPx = Math.round(W * 0.055);

  // Barcode bitmap.
  const bc = document.createElement("canvas");
  try {
    JsBarcode(bc, opts.code, { format: "CODE128", displayValue: false, margin: 0, height: 90, width: 3 });
  } catch { /* invalid code — skip barcode */ }
  const bcW = W - pad * 2;
  const bcH = bc.width ? Math.min(Math.round(bc.height * bcW / bc.width), Math.round(W * 0.2)) : 0;
  const codePx = Math.round(W * 0.09);

  const H =
    pad + Math.round(namePx * 1.15) +
    subs.length * Math.round(subPx * 1.25) + (subs.length ? 8 : 0) +
    14 + bcH + 8 + Math.round(codePx * 1.2) + pad;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111"; ctx.textAlign = "center"; ctx.textBaseline = "top";

  let y = pad;
  ctx.font = `800 ${namePx}px Barlow, Arial, sans-serif`;
  ctx.fillText(opts.name, cx, y); y += Math.round(namePx * 1.15);

  ctx.fillStyle = "#555";
  ctx.font = `600 ${subPx}px Barlow, Arial, sans-serif`;
  for (const s of subs) { ctx.fillText(s, cx, y); y += Math.round(subPx * 1.25); }
  if (subs.length) y += 8;

  ctx.fillStyle = "#111";
  y += 6;
  if (bcH) ctx.drawImage(bc, pad, y, bcW, bcH);
  y += bcH + 8;
  ctx.font = `700 ${codePx}px Barlow, Arial, sans-serif`;
  ctx.fillText(opts.code, cx, y);

  return canvas;
}
