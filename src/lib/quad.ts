/* Quad geometry for pinning a slot grid onto a photo of a real space.
 *
 * The mapped region is a quadrilateral (four corners, normalized 0..1 image
 * coordinates, order TL TR BR BL). Cells are placed by bilinear interpolation,
 * which follows the photo's perspective well enough to sit each cell on the
 * physical bin it represents — the "CAD mockup on the photo" effect. */

export interface Pt {
  x: number;
  y: number;
}

/** TL, TR, BR, BL — normalized to the image (0..1). */
export type QuadCorners = [Pt, Pt, Pt, Pt];

export const DEFAULT_QUAD: QuadCorners = [
  { x: 0.08, y: 0.08 },
  { x: 0.92, y: 0.08 },
  { x: 0.92, y: 0.92 },
  { x: 0.08, y: 0.92 },
];

/** Point at parametric (u, v) inside the quad; u = across, v = down, both 0..1. */
export function quadPoint(q: QuadCorners, u: number, v: number): Pt {
  const [tl, tr, br, bl] = q;
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

/** Polygon (TL TR BR BL) for cell (row, col), 1-based, inside a rows x cols grid. */
export function cellQuad(q: QuadCorners, row: number, col: number, rows: number, cols: number): QuadCorners {
  const u0 = (col - 1) / cols, u1 = col / cols;
  const v0 = (row - 1) / rows, v1 = row / rows;
  return [quadPoint(q, u0, v0), quadPoint(q, u1, v0), quadPoint(q, u1, v1), quadPoint(q, u0, v1)];
}

/** SVG points string (in a viewBox scaled by w x h) for a cell polygon. */
export function quadToSvgPoints(q: QuadCorners, w: number, h: number): string {
  return q.map((p) => `${(p.x * w).toFixed(2)},${(p.y * h).toFixed(2)}`).join(" ");
}

/** Build a quad from a plain bounding box (x, y, w, h normalized). */
export function quadFromBox(b: { x: number; y: number; w: number; h: number }): QuadCorners {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const x0 = clamp(b.x), y0 = clamp(b.y);
  const x1 = clamp(b.x + b.w), y1 = clamp(b.y + b.h);
  if (x1 - x0 < 0.05 || y1 - y0 < 0.05) return DEFAULT_QUAD;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}
