// Minimal browser globals for unit tests that run in the plain node environment.
//
// Most of what we test is pure logic, but importing anything that reaches the Supabase client pulls
// in `storage: localStorage` at module scope. A tiny in-memory shim is enough and keeps jsdom out of
// devDependencies — the tests here assert on data, never on a rendered DOM.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), writable: true });
}
