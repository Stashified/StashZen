/**
 * listCache, module-scope cache for paginated list responses.
 *
 * A Map plus an inflight Map plus a clear export, shared by the list services.
 *
 * WHY THE SOURCE IS IN EVERY KEY. These Maps live at module scope, so they
 * outlive the `key={dataKey}` remount in App.jsx that discards the previous
 * source. Keying on request parameters alone would hand one Stash instance's
 * scenes to another, or serve Test mocks in Live, so keys are only built
 * through `listCacheKey()`, which folds in `dataSourceKey()`.
 *
 * Bounded, because a long browse session mints a key per page.
 */

import { dataSourceKey } from './settings.js';

// ~50 entries x 40 scenes is a few MB of normalised objects, enough for a
// deep scroll plus the page-1 keys that tab switches keep coming back to.
const MAX_ENTRIES = 50;

/**
 * NUL-joined: NUL can't occur in a URL, a sort enum or a search string, so
 * adjacent parts can't run together into a colliding key. Objects (the
 * `*_filter` payloads) are JSON-encoded, key order is insertion order, so
 * the same filter object always produces the same key.
 */
const SEP = '\u0000';

export function listCacheKey(...parts) {
  return [
    dataSourceKey(),
    ...parts.map(p => {
      if (p == null) return '';
      return typeof p === 'object' ? JSON.stringify(p) : String(p);
    }),
  ].join(SEP);
}

// Every cache this module has handed out. Module scope means a React remount
// cannot drop them, so `clearAllListCaches` is the explicit way out when the
// user leaves a tab. Without it, returning to Home remounts every shelf, serves
// page 1 from this Map, and never sees a scene added on the server.
const caches = new Set();

export function createListCache() {
  const cache = new Map();     // key -> value, in least-recently-used order
  const inflight = new Map();  // key -> Promise
  // Bumped by clear(). A request that was already in flight when the cache
  // was invalidated must not write its (now stale) result back in.
  let generation = 0;

  function remember(key, value) {
    cache.delete(key);   // re-insert at the end so Map order tracks recency
    cache.set(key, value);
    while (cache.size > MAX_ENTRIES) {
      cache.delete(cache.keys().next().value);   // evict least recently used
    }
  }

  const api = {
    /**
     * Return the cached value for `key`, or run `loader()` to produce it.
     * Concurrent callers for the same key share one request.
     */
    get(key, loader) {
      if (cache.has(key)) {
        const hit = cache.get(key);
        remember(key, hit);                       // touch
        return Promise.resolve(hit);
      }
      if (inflight.has(key)) return inflight.get(key);

      const gen = generation;
      // Delete *this* promise, not whatever is under the key: after a clear()
      // an old request is still running while a new one is registered, and an
      // unconditional delete would let the old answer remove the new slot, so
      // the next caller starts a third request instead of joining.
      const settle = () => {
        if (inflight.get(key) === p) inflight.delete(key);
      };
      const p = loader()
        .then(value => {
          settle();
          if (gen === generation) remember(key, value);
          return value;
        })
        .catch(err => {
          settle();
          throw err;
        });

      inflight.set(key, p);
      return p;
    },

    clear() {
      generation++;
      cache.clear();
      inflight.clear();
    },
  };

  caches.add(api);
  return api;
}

/**
 * Drop every cached list page, in every service, at once.
 *
 * `clearScenePages`-style exports cover writes the app makes; this covers what
 * it cannot see, the library changed on the server. Called on tab switch so
 * arriving re-reads page 1 (the remount alone was not enough).
 */
export function clearAllListCaches() {
  for (const cache of caches) cache.clear();
}
