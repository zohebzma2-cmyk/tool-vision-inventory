// Pure search logic for Find Mode — query normalization, ranking, and the spoken answer. Kept
// dependency-free (no supabase) so the phrasing users hear can be unit-tested. The DB round-trips
// live in the component; this module decides what to search for, how to rank, and what to say.

// Filler words stripped from a spoken/typed query so "where's my chalk line" → "chalk line".
export const FILLER = /\b(where'?s?|is|are|the|my|a|an|find|me|located|do i have|any|show|look for|got)\b/g;

/** Normalize a raw query into search tokens. `needles` are the words to match (min length 3), or the
 *  whole cleaned string if nothing survives tokenization. */
export function normalizeQuery(raw: string): { cleaned: string; needles: string[] } {
  const cleaned = raw.toLowerCase().replace(FILLER, " ").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return { cleaned: "", needles: [] };
  const tokens = cleaned.split(" ").filter((t) => t.length > 2);
  return { cleaned, needles: tokens.length ? tokens : [cleaned] };
}

export interface RankItem { name: string; category?: string | null }

/** Rank items by how well name/category match the needles (name hits weigh more), best first. */
export function rankItems<T extends RankItem>(items: T[], needles: string[], limit = 5): T[] {
  return items
    .map((it) => {
      const nl = (it.name || "").toLowerCase();
      const cl = (it.category || "").toLowerCase();
      const score = needles.reduce((s, t) => s + (nl.includes(t) ? 2 : 0) + (cl.includes(t) ? 1 : 0), 0);
      return { it, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.it);
}

export interface AnswerHit { name: string; category?: string | null; bin: string | null; shelf: string | null }

/** The sentence the assistant speaks for a set of ranked hits. */
export function spokenAnswer(query: string, hits: AnswerHit[]): string {
  if (!hits.length) return `I couldn't find anything matching ${query}.`;
  const top = hits[0];
  const where = top.bin
    ? `${top.bin}${top.category ? `, in ${top.category}` : ""}${top.shelf ? `, on ${top.shelf}` : ""}`
    : "the inventory, but it isn't filed in a bin yet";
  const more = hits.length > 1 ? ` I found ${hits.length - 1} other match${hits.length - 1 === 1 ? "" : "es"} too.` : "";
  return `${top.name} is in ${where}.${more}`;
}
