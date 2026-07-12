// Vision provider abstraction.
//
// All AI calls go through the vision Worker at VITE_VISION_API_URL, which serves them from the
// self-hosted model (LiteLLM -> Ollama qwen2.5vl) first and falls back to free cloud models only
// if the box is unreachable — one consistent brain. If VITE_VISION_API_URL is unset, every call
// throws `VisionNotConfiguredError` and callers fall back to fully-manual flows.

import { supabase } from "@/integrations/supabase/client";

export class VisionNotConfiguredError extends Error {
  constructor() {
    super("Vision service is not configured yet (VITE_VISION_API_URL is unset).");
    this.name = "VisionNotConfiguredError";
  }
}

export function visionApiUrl(): string | null {
  const url = import.meta.env.VITE_VISION_API_URL as string | undefined;
  return url && url.trim() ? url.replace(/\/$/, "") : null;
}

export function isVisionConfigured(): boolean {
  return visionApiUrl() !== null;
}

/** AI proposal for how to subdivide a physical space into a grid of slots. */
export interface SpaceSuggestion {
  type?: string; // one of the location types (pegboard, drawer, shelf, ...)
  gridRows?: number;
  gridCols?: number;
  /** Bounding box of the storage unit within the photo, normalized 0..1. */
  region?: { x: number; y: number; w: number; h: number } | null;
  slotNames?: string[]; // optional per-cell names, row-major
  notes?: string;
  confidence?: number; // 0..1
}

/** AI identification of a single tool/item from a photo. */
export interface ItemSuggestion {
  name?: string;
  category?: string;
  brand?: string;
  model?: string;
  text?: string; // OCR of any labels
  confidence?: number;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const base = visionApiUrl();
  if (!base) throw new VisionNotConfiguredError();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Attach the signed-in user's token so the vision Worker can gate access to real users.
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) headers["Authorization"] = `Bearer ${data.session.access_token}`;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Vision service error ${res.status}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Ask the vision model to propose a grid layout for a space photo. */
export async function suggestSpaceFromImage(
  imageDataUrl: string,
  hint?: string,
): Promise<SpaceSuggestion> {
  return postJson<SpaceSuggestion>("/map-space", { imageDataUrl, hint: hint ?? "" });
}

/** Ask the vision model to identify a single item/tool from a photo. */
export async function identifyItemFromImage(imageDataUrl: string): Promise<ItemSuggestion> {
  return postJson<ItemSuggestion>("/identify-item", { imageDataUrl });
}

/** One recognized item from a bin-contents photo. */
export interface BinItemSuggestion {
  name: string;
  category: string;
  kind: "part" | "tool" | "set" | "consumable";
  brand: string;
  model: string;
  quantity: number;
  confidence: number;
}

/** Ask the vision model to list every item visible in a bin-contents photo. */
export async function identifyBinFromImage(imageDataUrl: string): Promise<BinItemSuggestion[]> {
  const out = await postJson<{ items: BinItemSuggestion[] }>("/identify-bin", { imageDataUrl });
  return Array.isArray(out.items) ? out.items : [];
}
