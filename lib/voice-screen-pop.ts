// Tiny in-process store for voice screen-pop events.
//
// When Mark's voice brain emits a `[SCREEN: <key>]` marker, the voice route
// records the latest pop here, keyed by sessionId. The browser's voice page
// polls /api/voice/screen-pop and pops the matching page in an iframe.
//
// Storage is process-local — fine because Mark runs on one Railway service
// instance. If we ever scale horizontally we'd swap this for Redis or a
// findings-DB row. For now an in-memory Map with a 60s TTL is plenty.

type Entry = { key: string; at: number; consumed: boolean };
const STORE = new Map<string, Entry>();
const TTL_MS = 60_000;

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of STORE.entries()) {
    if (v.at < cutoff) STORE.delete(k);
  }
}

export async function recordScreenPop(sessionId: string, key: string): Promise<void> {
  sweep();
  STORE.set(sessionId, { key, at: Date.now(), consumed: false });
}

/**
 * Fetch the latest pop for a session and mark it consumed. Returns null if
 * nothing fresh to pop. Each pop is only delivered ONCE — the browser
 * polling next time gets null until the next pop lands.
 */
export async function takeScreenPop(sessionId: string): Promise<{ key: string; at: number } | null> {
  sweep();
  const e = STORE.get(sessionId);
  if (!e || e.consumed) return null;
  e.consumed = true;
  return { key: e.key, at: e.at };
}
