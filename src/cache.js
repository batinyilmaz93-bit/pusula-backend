// cache.js — tiny in-memory TTL cache.
// Production note: swap the Map for Redis (same get/set/del shape) once you
// run more than one server instance, so cache hits are shared across them.

const store = new Map();

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { store.delete(key); return null; }
  return hit.value;
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}
