// Speech-to-text for Rapid Mode: record a short mic clip in the browser and transcribe it with the
// local whisper.cpp running on the desktop connector (/transcribe). Works on the desktop station
// (same-origin localhost) and in the iOS app (reaches the connector over Wi-Fi, like printing does).

import { connectorBase } from "@/components/inventory/PrinterService";

/** The best audio container the browser can record (Opus in WebM on Chrome, MP4/AAC on Safari/iOS). */
function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

/** Record `ms` of audio from `stream` and return the clip. */
export function recordClip(stream: MediaStream, ms = 3500): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let rec: MediaRecorder;
    try {
      const mime = pickMime();
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      reject(e);
      return;
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    rec.onerror = () => resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    rec.start();
    setTimeout(() => { try { rec.state !== "inactive" && rec.stop(); } catch { /* ignore */ } }, ms);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Send a recorded clip to the connector's whisper.cpp and return the recognized text (lowercased). */
export async function transcribe(blob: Blob): Promise<string> {
  if (!blob.size) return "";
  const audio = await blobToDataUrl(blob);
  const res = await fetch(`${connectorBase()}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) return "";
  const j = (await res.json().catch(() => ({}))) as { text?: string };
  return (j.text || "").toString().trim().toLowerCase();
}

/** Record then transcribe in one call. */
export async function listen(stream: MediaStream, ms = 3500): Promise<string> {
  return transcribe(await recordClip(stream, ms));
}
