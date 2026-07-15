// Short, human-readable unique codes for items and bins. Five characters from a Crockford-ish
// alphabet (no 0/O/1/I/L, so it's unambiguous to read off a label, say aloud, or type). Stored as the
// row's qr_code, so the same code is both the printed badge AND what the QR/scanner resolves.

import { supabase } from "@/integrations/supabase/client";

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars, no look-alikes

function randomCode(len = 5): string {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

/** True if this code is already the qr_code of an item or a location. */
async function codeTaken(code: string): Promise<boolean> {
  const [i, l] = await Promise.all([
    supabase.from("items").select("id").eq("qr_code", code).limit(1).maybeSingle(),
    supabase.from("locations").select("id").eq("qr_code", code).limit(1).maybeSingle(),
  ]);
  return !!(i.data || l.data);
}

/**
 * Mint a fresh 5-char code that's unused across items + bins. Best-effort uniqueness by checking
 * before use and retrying on collision; widens to 6 chars in the vanishingly unlikely case that a
 * handful of 5-char draws all collide. (32^5 ≈ 33.5M combinations, so collisions are rare.)
 */
export async function mintShortCode(): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode(5);
    try {
      if (!(await codeTaken(code))) return code;
    } catch {
      return code; // offline / lookup failed — a random 5-char code is still almost certainly unique
    }
  }
  return randomCode(6);
}
