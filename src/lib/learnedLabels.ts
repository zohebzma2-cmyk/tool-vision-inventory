// Self-learning from your corrections. When the scanner is unsure and you fix a guess, we remember
// "what the model called it" -> "what you said it was", so next time that same thing shows up it
// auto-fills with your answer (and files even at low confidence, since you've already taught it).
// Device-local (localStorage) — instant, no backend — so the scanner you correct is the one that learns.

export interface Learned {
  name: string;
  category: string;
  brand?: string;
  uses: number; // how many times you've confirmed this mapping — a rough confidence
}

const KEY = "tv_learned_labels_v1";

/** Normalize a model label / free text into a stable lookup key. */
export function normKey(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function load(): Record<string, Learned> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, Learned>;
  } catch {
    return {};
  }
}

function save(map: Record<string, Learned>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable — learning is best-effort */
  }
}

/** What have you taught us this label means? null if we've never been corrected on it. */
export function getLearned(seenLabel: string): Learned | null {
  const k = normKey(seenLabel);
  if (!k) return null;
  return load()[k] || null;
}

/** Record a correction: the model saw `seenLabel`, you said it was `value`. Upserts + counts uses. */
export function recordCorrection(seenLabel: string, value: { name: string; category: string; brand?: string }): void {
  const k = normKey(seenLabel);
  if (!k || !value.name.trim()) return;
  const map = load();
  const prev = map[k];
  map[k] = {
    name: value.name.trim(),
    category: value.category || "Other",
    brand: value.brand?.trim() || prev?.brand,
    uses: (prev?.uses || 0) + 1,
  };
  save(map);
}

/** For diagnostics / a future "what I've learned" view. */
export function allLearned(): Array<{ key: string } & Learned> {
  const map = load();
  return Object.entries(map).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.uses - a.uses);
}
