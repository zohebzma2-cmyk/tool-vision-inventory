// In-app bin label: a big bin number, the location, a scannable Code128 barcode (for the USB 1D
// scanner), and the code text — rendered to a canvas at the loaded tape's dimensions. This is the
// same label the "print all bin labels" batch lays down, so anyone can reprint a bin wall in-app
// with zero friction (no scripts, no MCP).

import JsBarcode from "jsbarcode";

/** Tape presets: printable dots (w×h) per DK media id. Continuous tapes have a nominal height. */
export const TAPE_PRESETS: Record<string, { w: number; h: number; label: string; diecut: boolean }> = {
  "29x90": { w: 306, h: 991, label: "29×90 mm die-cut (DK-1201)", diecut: true },
  "62":    { w: 696, h: 460, label: "62 mm continuous", diecut: false },
  "29":    { w: 306, h: 460, label: "29 mm continuous", diecut: false },
  "12":    { w: 106, h: 320, label: "12 mm continuous", diecut: false },
  "62x100":{ w: 696, h: 1109, label: "62×100 mm die-cut", diecut: true },
};

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxPx: number, weight = 700): number {
  let px = maxPx;
  for (; px > 10; px -= 2) {
    ctx.font = `${weight} ${px}px Barlow, Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return px;
}

/** Render a bin label to a canvas sized for `media`. Content is vertically centered on die-cut tapes.
 *  `category` (what the bin holds — e.g. "PPE", "Marking Tools") prints under the big bin number so a
 *  glance at the wall tells you what's in each bin, not just its number. */
export function renderBinLabel(
  opts: { number: string | number; code: string; location: string; category?: string; media?: string },
): HTMLCanvasElement {
  const preset = TAPE_PRESETS[opts.media || "29x90"] || TAPE_PRESETS["29x90"];
  const W = preset.w, H = preset.h;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  const pad = Math.round(W * 0.06);
  const cx = W / 2;

  // --- build the block into a temp list so we can vertically center it ---
  const parts: Array<{ draw: (y: number) => number }> = [];

  // location header (wrap into up to 2 lines)
  const words = opts.location.split(" ");
  const headLines = words.length > 1 ? [words[0], words.slice(1).join(" ")] : [opts.location];
  const headPx = fitFont(ctx, headLines.reduce((a, b) => a.length > b.length ? a : b, ""), W - pad * 2, Math.round(W * 0.14));
  parts.push({ draw: (y) => {
    ctx.font = `700 ${headPx}px Barlow, Arial, sans-serif`;
    for (const l of headLines) { ctx.fillText(l, cx, y); y += headPx * 1.14; }
    ctx.fillRect(pad, y + 6, W - pad * 2, 3); return y + 6 + 3 + 18;
  }});

  // big bin number
  const numPx = Math.min(Math.round(W * 0.78), Math.round(H * 0.28));
  parts.push({ draw: (y) => {
    ctx.font = `800 ${numPx}px Barlow, Arial, sans-serif`;
    ctx.fillText(String(opts.number), cx, y); return y + numPx * 1.02 + 24;
  }});

  // category — what the bin holds (wraps to at most 2 lines, sits under the number)
  const category = (opts.category || "").trim();
  if (category) {
    const words = category.split(" ");
    const catLines: string[] = [];
    let cur = "";
    ctx.font = `700 ${Math.round(W * 0.11)}px Barlow, Arial, sans-serif`;
    for (const w of words) {
      const t = (cur ? cur + " " + w : w);
      if (ctx.measureText(t).width <= W - pad * 2) cur = t;
      else { if (cur) catLines.push(cur); cur = w; }
    }
    if (cur) catLines.push(cur);
    const catPx = fitFont(ctx, catLines.reduce((a, b) => a.length > b.length ? a : b, ""), W - pad * 2, Math.round(W * 0.11), 700);
    parts.push({ draw: (y) => {
      ctx.font = `700 ${catPx}px Barlow, Arial, sans-serif`;
      for (const l of catLines.slice(0, 2)) { ctx.fillText(l, cx, y); y += catPx * 1.14; }
      return y + 14;
    }});
  }

  // Code128 barcode
  const bcCanvas = document.createElement("canvas");
  try {
    JsBarcode(bcCanvas, opts.code, { format: "CODE128", displayValue: false, margin: 0, height: 90, width: 3 });
  } catch { /* invalid code — skip barcode */ }
  const bcW = W - pad * 2;
  const bcH = bcCanvas.width ? Math.min(Math.round(bcCanvas.height * bcW / bcCanvas.width), Math.round(H * 0.22)) : 0;
  parts.push({ draw: (y) => {
    if (bcH) ctx.drawImage(bcCanvas, pad, y, bcW, bcH);
    return y + bcH + 8;
  }});

  // code text
  const codePx = Math.round(W * 0.15);
  parts.push({ draw: (y) => {
    ctx.font = `700 ${codePx}px Barlow, Arial, sans-serif`;
    ctx.fillText(opts.code, cx, y); return y + codePx * 1.1;
  }});

  // measure total block height (dry run on a scratch context), then draw centered
  let total = 0; { let y = 0; for (const p of parts) y = p.draw(y); total = y; }
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); ctx.fillStyle = "#111"; // clear the dry run
  let y = Math.max(pad, Math.round((H - total) / 2));
  for (const p of parts) y = p.draw(y);
  return canvas;
}
