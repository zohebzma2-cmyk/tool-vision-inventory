// Text-to-speech via the browser's built-in speech synthesis — cross-platform (Chrome on the desktop
// station + iOS WKWebView in the native app), fully local, zero cost. Rapid Mode uses this so the
// assistant talks the user through hands-free labeling; the spoken words are also captioned on screen.

let cachedVoice: SpeechSynthesisVoice | null = null;

/** Pick a natural US-English voice once available (voices load async on some platforms). */
function pickVoice(): SpeechSynthesisVoice | null {
  const synth = window.speechSynthesis;
  if (!synth) return null;
  if (cachedVoice) return cachedVoice;
  const voices = synth.getVoices() || [];
  cachedVoice =
    voices.find((v) => /en[-_]US/i.test(v.lang) && /Samantha|Alex|Aaron|Google US English|Nicky/i.test(v.name)) ||
    voices.find((v) => /en[-_]US/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    voices[0] ||
    null;
  return cachedVoice;
}

// Prime the voice list as soon as it's ready (Chrome fires this after first access).
if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => { cachedVoice = null; pickVoice(); };
}

/** Speak `text` and resolve when it finishes (or immediately if TTS is unavailable). */
export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth || !text.trim()) { resolve(); return; }
    try { synth.cancel(); } catch { /* ignore */ }
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.05;
    u.pitch = 1;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    u.onend = finish;
    u.onerror = finish;
    // Safety timeout: some platforms never fire onend for short utterances.
    setTimeout(finish, Math.min(12000, 1200 + text.length * 90));
    synth.speak(u);
  });
}

export function stopSpeaking(): void {
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}
