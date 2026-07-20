// Pure parsing for the hands-free voice commands (Rapid Mode). Kept dependency-free and separate from
// the React component so it can be unit-tested and reused. A transcript from whisper.cpp is messy
// (lowercased, loose punctuation, filler words), so matching is intentionally forgiving.

export const YES = /\b(yes|yeah|yep|yup|label|add|do it|okay|ok|sure|correct|print|go)\b/;
export const SKIP = /\b(skip|no|nope|next|pass|wrong|another)\b/;
export const DONE = /\b(done|finish|finished|close|complete|that'?s it|stop|end|exit|quit)\b/;
export const UNDO = /\b(undo|remove last|delete that|take that back|scratch that|oops)\b/;

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Pull a quantity out of a spoken command ("yes two", "add 3"). Defaults to 1; clamped to 1–99. */
export function parseQty(cmd: string): number {
  const digit = cmd.match(/\b(\d{1,2})\b/);
  if (digit) return Math.max(1, Math.min(99, parseInt(digit[1], 10)));
  for (const [w, n] of Object.entries(WORD_NUM)) if (new RegExp(`\\b${w}\\b`).test(cmd)) return n;
  return 1;
}

const CORRECTION = /\b(?:it'?s|it is|that'?s|actually|its)\b\s+(?:an?\s+)?(.+)/;

/** A spoken correction like "no, it's a chalk line" / "actually a torque wrench" → the corrected name
 *  (Title Cased), or null if the command isn't a correction. */
export function parseCorrection(cmd: string): string | null {
  const m = cmd.match(CORRECTION);
  if (!m) return null;
  const name = m[1].replace(/[^\w\s-]/g, "").trim();
  return name.length >= 2 ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

export type CommandKind = "done" | "undo" | "yes" | "skip" | "unclear";

export interface ParsedCommand { kind: CommandKind; qty: number; correctedName: string | null }

/** Classify a confirm-step transcript. Precedence: done → undo → correction(=yes) → skip → yes →
 *  unclear. A correction ("no it's a X") counts as a yes with the corrected name. */
export function classifyCommand(cmd: string): ParsedCommand {
  const qty = parseQty(cmd);
  if (DONE.test(cmd)) return { kind: "done", qty, correctedName: null };
  if (UNDO.test(cmd)) return { kind: "undo", qty, correctedName: null };
  const correctedName = parseCorrection(cmd);
  if (correctedName) {
    // Numbers inside a correction belong to the tool's NAME, not to a count — "it's a 10 mm wrench"
    // means one wrench, not ten. Garage corrections are full of sizes, voltages, drives and gauges,
    // and a misread here both sets the wrong stock count and prints that many labels. So only the
    // text BEFORE the correction ("add two, it's a 10 mm wrench") can carry a quantity.
    const at = cmd.search(CORRECTION);
    return { kind: "yes", qty: parseQty(at > 0 ? cmd.slice(0, at) : ""), correctedName };
  }
  if (SKIP.test(cmd)) return { kind: "skip", qty, correctedName: null };
  if (YES.test(cmd)) return { kind: "yes", qty, correctedName: null };
  return { kind: "unclear", qty, correctedName: null };
}
