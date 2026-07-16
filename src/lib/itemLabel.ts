// In-app item label: the item name, up to two detail lines, a scannable Code128 barcode for the USB
// 1D scanner, the 5-char code, and — when the brand is known — the maker's real logo in the corner
// (DeWalt, Griot's, DuPont…). Rendered to a canvas at the loaded tape's width so Rapid Mode can print
// a matching label the instant an item is confirmed. Mirrors the bin label (src/lib/binLabel.ts).

import JsBarcode from "jsbarcode";
import { TAPE_PRESETS } from "@/lib/binLabel";
import { logoImageUrl, resolveBrandDomain } from "@/lib/brandLogo";

// Fast path: common tool/PPE/auto brands → domain, so the logo resolves instantly with no round-trip.
// Anything not here falls back to the vision Worker's brand lookup (resolveBrandDomain).
const KNOWN_BRANDS: Record<string, string> = {
  dewalt: "dewalt.com", milwaukee: "milwaukeetool.com", makita: "makita.com", bosch: "boschtools.com",
  ryobi: "ryobitools.com", ridgid: "ridgid.com", "harbor freight": "harborfreight.com",
  hercules: "harborfreight.com", bauer: "harborfreight.com", craftsman: "craftsman.com",
  kobalt: "kobalt.com", "husky": "huskytools.com", stanley: "stanleytools.com",
  "griot's garage": "griotsgarage.com", "griots garage": "griotsgarage.com", griots: "griotsgarage.com",
  dupont: "dupont.com", tyvek: "dupont.com", "3m": "3m.com", casoman: "casoman.com",
  irwin: "irwin.com", klein: "kleintools.com", "klein tools": "kleintools.com", knipex: "knipex.com",
  gearwrench: "gearwrench.com", snapon: "snapon.com", "snap-on": "snapon.com", festool: "festool.com",
  metabo: "metabo.com", "porter cable": "portercable.com", "porter-cable": "portercable.com",
  wera: "wera.de", milwaukee_tool: "milwaukeetool.com", diablo: "diablotools.com",
};

/** Resolve a brand → its logo URL (fast static map first, Worker fallback). Null if unknown/unconfigured. */
async function brandLogoUrl(brand: string, size = 128): Promise<string | null> {
  const key = brand.trim().toLowerCase();
  const domain = KNOWN_BRANDS[key] || (await resolveBrandDomain(brand));
  return domain ? logoImageUrl(domain, size) : null;
}

/** Load a brand's logo as an image, or null (never throws; capped so a slow logo can't block printing). */
export function loadBrandLogo(brand: string | undefined | null): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!brand) { resolve(null); return; }
    let done = false;
    const finish = (v: HTMLImageElement | null) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), 4500);
    brandLogoUrl(brand).then((url) => {
      if (!url) { finish(null); return; }
      const img = new Image();
      img.crossOrigin = "anonymous"; // logo.dev sends CORS headers → canvas stays untainted for toDataURL
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      img.src = url;
    }).catch(() => finish(null));
  });
}

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxPx: number, weight = 700): number {
  let px = maxPx;
  for (; px > 12; px -= 2) {
    ctx.font = `${weight} ${px}px Barlow, Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return px;
}

/** Render an item label sized for `media`. `logo` (a pre-loaded brand image) prints in the top-right. */
export function renderItemLabel(
  opts: { name: string; code: string; sub?: string[]; media?: string; logo?: HTMLImageElement | null },
): HTMLCanvasElement {
  const preset = TAPE_PRESETS[opts.media || "62"] || TAPE_PRESETS["62"];
  const W = preset.w;
  const pad = Math.round(W * 0.05);
  const subs = (opts.sub || []).filter((s) => s && s.trim()).slice(0, 2);

  // Logo box (top-right). Reserve its width so the name never runs under it.
  const logo = opts.logo || null;
  const logoBox = logo ? Math.round(W * 0.17) : 0;
  const logoW = logo ? Math.min(logoBox, Math.round(logoBox * (logo.width / Math.max(1, logo.height)))) : 0;
  const logoH = logo ? Math.round(logoW * (logo.height / Math.max(1, logo.width))) : 0;

  const scratch = document.createElement("canvas").getContext("2d")!;
  const nameMaxW = W - pad * 2 - (logo ? logoBox + Math.round(W * 0.03) : 0);
  const namePx = fitFont(scratch, opts.name, nameMaxW, Math.round(W * 0.11), 800);
  const subPx = Math.round(W * 0.055);

  const bc = document.createElement("canvas");
  try {
    JsBarcode(bc, opts.code, { format: "CODE128", displayValue: false, margin: 0, height: 90, width: 3 });
  } catch { /* invalid code — skip barcode */ }
  const bcW = W - pad * 2;
  const bcH = bc.width ? Math.min(Math.round(bc.height * bcW / bc.width), Math.round(W * 0.2)) : 0;
  const codePx = Math.round(W * 0.09);

  const headerH = Math.max(Math.round(namePx * 1.15) + subs.length * Math.round(subPx * 1.25), logoBox);
  const H = pad + headerH + (subs.length ? 8 : 0) + 14 + bcH + 8 + Math.round(codePx * 1.2) + pad;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "top";

  // logo top-right
  if (logo && logoW && logoH) {
    try { ctx.drawImage(logo, W - pad - logoW, pad, logoW, logoH); } catch { /* tainted — skip */ }
  }

  // name + subs, left-aligned (label style)
  ctx.fillStyle = "#111"; ctx.textAlign = "left";
  let y = pad;
  ctx.font = `800 ${namePx}px Barlow, Arial, sans-serif`;
  ctx.fillText(opts.name, pad, y); y += Math.round(namePx * 1.15);
  ctx.fillStyle = "#555";
  ctx.font = `600 ${subPx}px Barlow, Arial, sans-serif`;
  for (const s of subs) { ctx.fillText(s, pad, y); y += Math.round(subPx * 1.25); }

  // barcode spans full width below the header
  let by = pad + headerH + (subs.length ? 8 : 0) + 6;
  if (bcH) ctx.drawImage(bc, pad, by, bcW, bcH);
  by += bcH + 8;
  ctx.fillStyle = "#111"; ctx.textAlign = "center";
  ctx.font = `700 ${codePx}px Barlow, Arial, sans-serif`;
  ctx.fillText(opts.code, W / 2, by);

  return canvas;
}
