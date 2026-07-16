// A durable, self-retrying print queue. The QL-800 regularly drops off USB (asleep/off) and the
// connector can be briefly unreachable, so a label that can't print *right now* is persisted to
// localStorage and retried automatically until it lands. Rendered PNGs are stored inline; the queue
// keeps only the newest MAX jobs. If a write fails (quota), printResilient reports queued:false so
// the caller can flag a manual reprint rather than silently dropping the label.

import { printImageViaConnector } from "@/components/inventory/PrinterService";

const KEY = "tv-print-queue";
const MAX = 40; // keep the newest N; a garage bin wall is ~36 labels

interface Job { id: string; imageDataUrl: string; media?: string; label: string; ts: number; tries: number }

let flushing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(n: number) => void>();

function read(): Job[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}
/** Persist the queue. Returns false if the write failed (e.g. quota) — the caller must NOT then
 *  claim the job is safely queued, or a label would be lost with no trace. */
function write(jobs: Job[]): boolean {
  let ok = false;
  try { localStorage.setItem(KEY, JSON.stringify(jobs)); ok = true; } catch { ok = false; }
  listeners.forEach((l) => { try { l(jobs.length); } catch { /* ignore */ } });
  return ok;
}
function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Number of labels waiting to print. */
export function pendingPrints(): number { return read().length; }

/** Subscribe to queue-length changes (for a badge). Fires immediately with the current count. */
export function onQueueChange(cb: (n: number) => void): () => void {
  listeners.add(cb);
  cb(read().length);
  return () => { listeners.delete(cb); };
}

/** Print now; if it can't land, enqueue and keep retrying in the background. */
export async function printResilient(
  imageDataUrl: string, media: string | undefined, label: string,
): Promise<{ success: boolean; queued: boolean }> {
  const res = await printImageViaConnector(imageDataUrl, media);
  if (res?.success) return { success: true, queued: false };
  const jobs = read();
  jobs.push({ id: newId(), imageDataUrl, media, label, ts: Date.now(), tries: 1 });
  while (jobs.length > MAX) jobs.shift(); // drop oldest to stay under storage
  // If persistence fails (quota), report queued:false so the caller can flag a manual reprint —
  // never claim a label is safely queued when it wasn't actually stored.
  const persisted = write(jobs);
  if (!persisted) { console.warn(`[printQueue] could not persist "${label}" — reprint it manually.`); return { success: false, queued: false }; }
  scheduleFlush(4000);
  return { success: false, queued: true };
}

/** Try to print every queued label, oldest first. Stops on the first that still fails and backs off. */
export async function flushQueue(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    let jobs = read();
    while (jobs.length) {
      const job = jobs[0];
      const res = await printImageViaConnector(job.imageDataUrl, job.media);
      jobs = read(); // re-read: the user may have added more while we awaited
      if (res?.success) {
        write(jobs.filter((j) => j.id !== job.id));
        jobs = read();
      } else {
        const idx = jobs.findIndex((j) => j.id === job.id);
        if (idx >= 0) { jobs[idx] = { ...job, tries: job.tries + 1 }; write(jobs); }
        scheduleFlush(Math.min(60000, 4000 * (job.tries + 1))); // back off, try again later
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

function scheduleFlush(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void flushQueue(); }, ms);
}

// Auto-flush on load, when the network returns, and when the tab becomes visible again.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flushQueue());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void flushQueue(); });
  scheduleFlush(2500);
}
