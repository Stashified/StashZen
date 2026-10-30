/**
 * usePlayQueue: the ordered list a playback session walks
 *
 * "Play all" and "Play from here" mean the whole filtered result set, not the
 * pages the starting view had loaded. The queue is seeded with the view's
 * `items`, `total`, `page` and `fetchPage`, and extends past them on demand.
 *
 * Seeding rather than refetching keeps the queue in the order the user was
 * looking at, with no window for a second page-1 request to disagree with the
 * grid. The shared `fetchPage` closure also means extending onto a loaded page
 * is a `listCache` hit.
 *
 * `fetchPage` is optional: a single scene is a queue of one, and `exhausted`
 * is immediately true because `total` is 1.
 *
 * Nothing fetches on mount; the queue extends when the cursor comes within
 * EXTEND_THRESHOLD of the end, and again if `goNext` runs off the end.
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
  // The extension gave up with nothing new. A marker queue reports its marker
  // count, but its items are deduped by scene, so `items.length >= total` may
  // never hold; without the latch every Next at the end re-asks.
  const [ended, setEnded] = useState(false);
  const endedRef = useRef(false);
  const [index, setIndexState] = useState(startIndex);
  // The page is deliberately *not* state: nothing renders it, and it is only
  // ever read to work out which page to ask for next.

  // The array, page and cursor are read after an `await`, where a closure's
  // copy is stale. State stays the render source; these mirrors, written
  // together in one helper, are what the async paths read.
  const stateRef = useRef({ items: seedItems, total: seedTotal, page: seedPage });
  const indexRef = useRef(startIndex);
  // The pending extension itself, not a boolean: a caller arriving mid-flight
  // joins it and reads its result. Answering "no" stalled playback on the page
  // boundary while the next page was already on its way.
  const inFlightRef = useRef(null);
  // Rows removed from the panel. A later page can contain the same scene, and
  // the extension's own dedupe only knows what is still held; without this the
  // removed row reappears the next time the queue grows.
  const removedIdsRef = useRef(new Set());

  const setIndex = useCallback((next) => {
    indexRef.current = next;
    setIndexState(next);
  }, []);

  const exhausted = ended || (total > 0 && items.length >= total);

  const extend = useCallback(() => {
    if (!fetchPage) return Promise.resolve(false);
    if (endedRef.current) return Promise.resolve(false);
    if (inFlightRef.current) return inFlightRef.current;

    const before = stateRef.current;
    if (before.total > 0 && before.items.length >= before.total) return Promise.resolve(false);

    const run = (async () => {
      try {
        // More than one page per call because a single page can yield nothing
        // new: Stash's ordering shifts between requests, so a "next" page can
        // repeat rows already held. It still advanced the cursor, so ask for
        // the one after, returning false stranded playback at the boundary.
        // Bounded so a server repeating one page cannot spin here forever.
        let requestedPage = before.page;
        for (let attempt = 0; attempt <= MAX_DUPLICATE_PAGES; attempt++) {
          const cur = stateRef.current;
          if (cur.total > 0 && cur.items.length >= cur.total) return false;

          const data = await fetchPage(requestedPage + 1);
          requestedPage++;

          // Re-read: another render could have appended during the await, and
          // `stateRef` holds its last write.
          const after = stateRef.current;
          const seen = new Set(after.items.map(it => String(it.id)));
          const fresh = (data.items || []).filter(it => (
            !seen.has(String(it.id)) && !removedIdsRef.current.has(String(it.id))
          ));

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
        // Nothing new after the whole budget: this queue is done. `total`
        // becomes what we hold, because the server's marker count would
        // promise rows that resolve to scenes already in the list. The latch
        // stops the next press from asking again.
        const cur = stateRef.current;
        endedRef.current = true;
        setEnded(true);
        setTotal(cur.items.length);
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
  // between advancing and stopping, and it cannot ask `hasNext`, that is
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

  /**
   * Jump to a loaded row. The panel only lists rows that are here, so there is
   * nothing to fetch: a jump beyond the window reads as "no such row" rather
   * than paging a screen the user cannot see.
   */
  const goTo = useCallback((target) => {
    const at = Number(target);
    if (!Number.isInteger(at) || at < 0 || at >= stateRef.current.items.length) return false;
    if (at === indexRef.current) return false;
    setIndex(at);
    return true;
  }, [setIndex]);

  /**
   * Drop a row ahead of (or behind) the cursor. The row on screen is refused:
   * removing it would leave the element playing something the queue no longer
   * names, and "skip this one" already exists as Next.
   *
   * `total` drops by one so the queue stays extendable, and the scene is
   * remembered so a later page cannot bring it back.
   */
  const removeAt = useCallback((target) => {
    const before = stateRef.current;
    const at = Number(target);
    if (!Number.isInteger(at) || at < 0 || at >= before.items.length) return false;
    if (at === indexRef.current) return false;
    const nextItems = before.items.filter((_, i) => i !== at);
    removedIdsRef.current.add(String(before.items[at].id));
    const next = {
      ...before,
      items: nextItems,
      total: before.total > 0 ? Math.max(nextItems.length, before.total - 1) : 0,
    };
    stateRef.current = next;
    setItems(next.items);
    setTotal(next.total);
    if (at < indexRef.current) setIndex(indexRef.current - 1);
    return true;
  }, [setIndex]);

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
    goTo,
    removeAt,
    extend,
  };
}
