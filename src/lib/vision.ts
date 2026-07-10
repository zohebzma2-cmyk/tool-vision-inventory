// Vision provider abstraction.
//
// The self-hosted open-source model service (Ollama + a small adapter running on the Mac mini,
// exposed via a Cloudflare Tunnel) is reached through VITE_VISION_API_URL. Until that is wired up,
// every call throws `VisionNotConfiguredError`, and callers fall back to fully-manual flows so the
// app is 100% usable offline.

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
