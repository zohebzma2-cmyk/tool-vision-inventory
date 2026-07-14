import { Camera, Grid3x3, QrCode, Layers, Boxes, type LucideIcon } from "lucide-react";

/** One walkthrough step — shared by first-run Onboarding and the always-available "How it works". */
export interface GuideStep {
  icon: LucideIcon;
  title: string;
  body: string;
}

export const GUIDE_STEPS: GuideStep[] = [
  {
    icon: Grid3x3,
    title: "Map your storage",
    body: "Point the camera at a pegboard, drawer, or shelf. The AI turns it into a grid of labeled slots so the app remembers what lives where.",
  },
  {
    icon: Boxes,
    title: "Sort a bin",
    body: "Snap the inside of a tote and the AI lists everything in it and guesses the size. Confirm, and it's stored as a numbered bin — with a printable label.",
  },
  {
    icon: Camera,
    title: "Add tools with the camera",
    body: "Snap a tool and the AI fills in the name, brand, and model. You review, tweak, and save — no typing part numbers.",
  },
  {
    icon: QrCode,
    title: "Label everything",
    body: "Each location, bin, and tool gets a QR label you can print on a Brother printer. Scan a label later to jump straight to what's stored there.",
  },
];

/** The core mental model, shown at the top of "How it works" so the vocabulary clicks. */
export const GUIDE_HIERARCHY: { icon: LucideIcon; term: string; blurb: string }[] = [
  { icon: Layers, term: "Space", blurb: "A room or area — your garage, shed, or basement." },
  { icon: Grid3x3, term: "Location", blurb: "A storage unit inside a space — a pegboard, shelf, or bin rack." },
  { icon: QrCode, term: "Slot / Bin", blurb: "One spot inside a location where a specific tool or part lives." },
];
