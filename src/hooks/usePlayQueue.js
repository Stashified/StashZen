/**
 * usePlayQueue — the ordered list a playback session walks
 *
 * "Play all" and "Play from here" mean the whole filtered result set, not
 * the handful of pages the starting view happened to have loaded. So the
 * queue is seeded with what that view already holds — its `items`, its
 * `total`, the `page` it stopped at, and the `fetchPage` closure it pages
 * with — and then extends past the end of them on demand.
 *
 * Seeding rather than refetching is deliberate: the queue then continues in
 * exactly the order the user was looking at, with no window in which a
 * second page-1 request could disagree with the grid's. And because
 * `fetchPage` is the *same* closure the view uses, its requests go through
 * the same `listCache`, so extending onto a page the grid already loaded is
 * a cache hit rather than a second round trip.
 *
 * `fetchPage` is optional. A single scene — the detail page's Play button, a
 * marker's timestamp — is a queue of one with nothing to extend into, and
 * `exhausted` is immediately true because `total` is 1.
 *
 * The queue does not fetch on mount; it extends when the cursor comes within
 * EXTEND_THRESHOLD of the loaded end, and again if `goNext` runs off the end
 * before that happened.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// Start fetching the next page when the cursor is this close to the last
// loaded row, so the advance itself is instant.
const EXTEND_THRESHOLD = 3;

// How many consecutive all-duplicate pages one extension may skip. Two is
// enough for a reordered listing to resync; the bound exists so a server
// returning one page forever is a stop, not a loop.
const MAX_DUPLICATE_PAGES = 2;

export function usePlayQueue(queue) {
  const {
    items: seedItems = [],
    total: seedTotal = 0,
    page: seedPage = 1,
    startIndex = 0,
    fetchPage = null,
  } = queue || {};

  const [items, setItems] = useState(seedItems);
  const [total, setTotal] = useState(seedTotal);
  const [index, setIndexState] = useState(startIndex);
  // The page is deliberately *not* state: nothing renders it, and it is only
  // ever read to work out which page to ask for next.

  // The array, the page and the cursor are all read *after* an await as well
  // as during render, and a closure's copy is stale by then. State stays the
  // render source; these mirrors are what the async paths read. Written
  // together, in one helper, so they cannot drift.
  const stateRef = useRef({ items: seedItems, total: seedTotal, page: seedPage });
  const indexRef = useRef(startIndex);
  // The pending extension itself, not a boolean. A caller that arrives while
  // one is in flight joins it and reads its result — see `goNext`. Answering
  // "no" to that caller was the page-boundary bug: the prefetch starts three
  // items early, so a scene ending before it settled made `ended` stop on the
  // last frame of the page with the next page already on its way.
  const inFlightRef = useRef(null);

  const setIndex = useCallback((next) => {
    indexRef.current = next;
    setIndexState(next);
  }, []);

  const exhausted = total > 0 && items.length >= total;

  const extend = useCallback(() => {
    if (!fetchPage) return Promise.resolve(false);
    if (inFlightRef.current) return inFlightRef.current;

    const before = stateRef.current;
    if (before.total > 0 && before.items.length >= before.total) return Promise.resolve(false);

    const run = (async () => {
      try {
        // More than one page per call, because a single page can legitimately
        // yield nothing new: Stash's ordering shifts between requests, so the
        // "next" page can repeat rows the queue already holds in full. That
        // page still advanced the cursor, so the honest answer is to ask for
        // the one after it — returning false on it stranded playback on the
        // page boundary with scenes left in the listing. Bounded, because a
        // server that answers every request with the same page would
        // otherwise spin here for as long as the queue is open.
        let requestedPage = before.page;
        for (let attempt = 0; attempt <= MAX_DUPLICATE_PAGES; attempt++) {
          const cur = stateRef.current;
          if (cur.total > 0 && cur.items.length >= cur.total) return false;

          const data = await fetchPage(requestedPage + 1);
          requestedPage++;

          // Re-read: the await is exactly where another render could have
          // appended, and `stateRef` holds whatever the hook's own last write
          // left there.
          const after = stateRef.current;
          const seen = new Set(after.items.map(it => it.id));
          const fresh = (data.items || []).filter(it => !seen.has(it.id));

          const next = {
            items: [...after.items, ...fresh],
            page: after.page + 1,
            total: data.total || after.total,
          };
          stateRef.current = next;
          setItems(next.items);
          setTotal(next.total);
          if (fresh.length > 0) return true;
        }
        return false;
      } catch {
        // A failed extension is not worth interrupting playback for: the
        // current scene is still playing and the user can press next again.
        return false;
      }
    })();

    inFlightRef.current = run;
    run.finally(() => { inFlightRef.current = null; });
    return run;
  }, [fetchPage]);

  // ── Keep the queue ahead of the cursor ────────────────────
  useEffect(() => {
    if (items.length === 0) return;
    if (items.length - index <= EXTEND_THRESHOLD) extend();
  }, [index, items.length, extend]);

  const hasPrev = index > 0;
  const hasNext = index + 1 < items.length || !exhausted;

  const goPrev = useCallback(() => {
    if (indexRef.current <= 0) return false;
    setIndex(indexRef.current - 1);
    return true;
  }, [setIndex]);

  // Returns whether the cursor actually moved. `ended` uses that to decide
  // between advancing and stopping, and it cannot ask `hasNext` — that is
  // the value from the render that set up the handler.
  const goNext = useCallback(async () => {
    if (indexRef.current + 1 < stateRef.current.items.length) {
      setIndex(indexRef.current + 1);
      return true;
    }
    const grew = await extend();
    if (grew && indexRef.current + 1 < stateRef.current.items.length) {
      setIndex(indexRef.current + 1);
      return true;
    }
    return false;
  }, [extend, setIndex]);

  return {
    items,
    total,
    index,
    current: items[index] || null,
    hasPrev,
    hasNext,
    exhausted,
    goPrev,
    goNext,
    extend,
  };
}
