// Data-driven, user-customizable label templates.
//
// A template describes a physical label (size in mm) and a set of positioned elements (text / QR)
// whose text is bound to {{tokens}} filled from the location or item being labeled. Positions and
// sizes are expressed as percentages of the label area so a template renders identically at any
// output resolution (screen preview, Brother QL raster, Brother PT tape).

export type LabelElementType = "text" | "qr";
export type LabelColor = "black" | "red"; // Brother two-color (62mm red/black) support
export type TextAlign = "left" | "center" | "right";

export interface LabelElement {
  id: string;
  type: LabelElementType;
  // Position + size as percentages (0..100) of the label area.
  x: number;
  y: number;
  w: number;
  h: number;
  // Text-only:
  value?: string; // template string with {{tokens}}, e.g. "{{name}}"
  fontScale?: number; // relative font size (1 = auto-fit to box height)
  bold?: boolean;
  align?: TextAlign;
  color?: LabelColor;
}

export interface LabelTemplate {
  id: string;
  name: string;
  description?: string;
  widthMm: number;
  heightMm: number; // 0 = continuous / auto-length
  elements: LabelElement[];
}

/** Tokens available to templates. */
export interface LabelData {
  name?: string;
  type?: string;
  category?: string;
  parent?: string;
  slot?: string; // e.g. "R2C3"
  row?: number | string;
  col?: number | string;
  index?: number | string;
  qr?: string; // value encoded into any QR element
  brand?: string;
  model?: string;
  date?: string;
  [key: string]: string | number | undefined;
}

/** Replace {{token}} occurrences in a string using LabelData (missing tokens render empty). */
export function renderTokens(template: string, data: LabelData): string {
  return template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_m, key: string) => {
    const v = data[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

let _uid = 0;
const eid = (p: string) => `${p}-${++_uid}`;

/** Built-in starter templates. Users can duplicate + customize these. */
export const BUILTIN_TEMPLATES: LabelTemplate[] = [
  {
    id: "slot-qr-left",
    name: "Slot · QR left",
    description: "62mm — QR on the left, slot name + coordinates on the right.",
    widthMm: 62,
    heightMm: 24,
    elements: [
      { id: eid("qr"), type: "qr", x: 3, y: 12, w: 34, h: 76, color: "black" },
      { id: eid("t"), type: "text", x: 42, y: 14, w: 55, h: 34, value: "{{name}}", bold: true, align: "left", color: "black" },
      { id: eid("t"), type: "text", x: 42, y: 52, w: 55, h: 24, value: "{{parent}} · {{slot}}", align: "left", color: "black" },
    ],
  },
  {
    id: "slot-compact",
    name: "Slot · compact tape",
    description: "24mm tape — big slot code, small QR. Great for P-touch cassettes.",
    widthMm: 24,
    heightMm: 12,
    elements: [
      { id: eid("t"), type: "text", x: 3, y: 10, w: 66, h: 80, value: "{{slot}}", bold: true, align: "left", color: "black" },
      { id: eid("qr"), type: "qr", x: 72, y: 8, w: 26, h: 84, color: "black" },
    ],
  },
  {
    id: "bin-big",
    name: "Bin · big name",
    description: "62mm — large bin/container name with QR, for grab-from-a-distance bins.",
    widthMm: 62,
    heightMm: 29,
    elements: [
      { id: eid("t"), type: "text", x: 4, y: 10, w: 66, h: 55, value: "{{name}}", bold: true, align: "left", color: "black" },
      { id: eid("t"), type: "text", x: 4, y: 66, w: 66, h: 26, value: "{{category}}", align: "left", color: "black" },
      { id: eid("qr"), type: "qr", x: 72, y: 10, w: 26, h: 80, color: "black" },
    ],
  },
  {
    id: "item-standard",
    name: "Item · name + category",
    description: "62mm — item name, category, and QR for checkout tracking.",
    widthMm: 62,
    heightMm: 24,
    elements: [
      { id: eid("qr"), type: "qr", x: 3, y: 12, w: 32, h: 76, color: "black" },
      { id: eid("t"), type: "text", x: 40, y: 14, w: 57, h: 36, value: "{{name}}", bold: true, align: "left", color: "black" },
      { id: eid("t"), type: "text", x: 40, y: 54, w: 57, h: 22, value: "{{brand}} {{model}}", align: "left", color: "black" },
    ],
  },
  {
    id: "two-color-header",
    name: "Two-color · red header",
    description: "62mm red/black — red banner name (needs QL two-color media).",
    widthMm: 62,
    heightMm: 29,
    elements: [
      { id: eid("t"), type: "text", x: 4, y: 6, w: 92, h: 34, value: "{{name}}", bold: true, align: "center", color: "red" },
      { id: eid("t"), type: "text", x: 4, y: 46, w: 66, h: 46, value: "{{parent}} · {{slot}}", align: "left", color: "black" },
      { id: eid("qr"), type: "qr", x: 72, y: 44, w: 26, h: 50, color: "black" },
    ],
  },
];

export function getTemplate(id: string | undefined | null): LabelTemplate {
  return BUILTIN_TEMPLATES.find((t) => t.id === id) ?? BUILTIN_TEMPLATES[0];
}

/** A deep clone so edits don't mutate the shared built-ins. */
export function cloneTemplate(t: LabelTemplate): LabelTemplate {
  return JSON.parse(JSON.stringify(t));
}
