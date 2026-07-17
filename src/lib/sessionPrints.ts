// Tracks item ids this browser session created/handled locally, so the desktop auto-print bridge
// doesn't double-print an item that a local flow (e.g. Rapid Mode) already printed. In-memory only —
// a session set, intentionally not persisted.

const sessionItemIds = new Set<string>();

/** Mark an item as created/printed by THIS session (call after a local create/print). */
export function noteSessionItem(id: string): void {
  if (id) sessionItemIds.add(id);
}

/** Did this session create/handle this item? The auto-print bridge skips these. */
export function isSessionItem(id: string): boolean {
  return sessionItemIds.has(id);
}
