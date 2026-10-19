/**
 * usePagedList — the pagination state machine the list views share
 *
 * VideoGrid, VideoCarousel, VideoCoverflow and the Reels feed each carried a
 * byte-for-byte copy of this. What they actually differed in was the request
 * (page size, and which fields of `controls` go into it) and *when* they ask
 * for more — the grid watches an IntersectionObserver sentinel, the others
 * watch how near the focused index is to the end of the list. So the
 * trigger stays with the caller and this hook stays agnostic about it; what
 * it owns is the part that was identical:
 *
 *   - the request-id guard, so a page that resolves after a reset (or after
 *     a sort change) cannot write its rows into the new list
 *   - the dedupe-by-id append, because Stash's ordering can shift between
 *     page requests and a row can legitimately appear twice
 *   - the "we already hold every row" stop
 *   - the in-flight flag, which is also what keeps two triggers from
 *     fetching the same page twice
 *
 * Usage:
 *
 *   const list = usePagedList({
 *     fetchPage: (page) => fetchVideos({ sort, order, filter: objectFilter,
 *                                         q: searchQuery, page, limit: PAGE_SIZE })
 *                   .then(d => ({ items: d.videos, total: d.total })),
 *     requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
 *   });
 *
 * `fetchPage(page)` takes a 1-based page number and resolves to
 * `{ items, total }` — `items` whatever entity the caller is listing, so the
 * hook does not need to know that scenes call their array `videos`. The page
 * size belongs to the caller, baked into the closure.
 *
 * `requestKey` is the caller's *request identity*: change it and the list
 * resets to page 1. Build it with `pageRequestKey` (utils/requestKey.js) from
 * everything that belongs to the request — never from `fetchPage`, and never
 * from the page number.
 *
 * Two stop conditions beyond "every row is held":
 *
 *   - **No progress.** A page that yields no new ids ends the list. Stash's
 *     count and its rows can disagree while a scan runs or a library shrinks;
 *     without this, the sentinel stays on screen and each empty page bumped
 *     `page`, chaining requests until the server reported a truthy total or
 *     one failed. `usePlayQueue` tolerates duplicate pages for a while
 *     (`MAX_DUPLICATE_PAGES`) because playback must keep moving; a listing
 *     has no such obligation, so it stops at the first no-progress page.
 *   - **A failed page.** The failure is shown and the same page is retried
 *     automatically, with a bounded budget (MAX_PAGE_ATTEMPTS, RETRY_DELAY_MS
 *     apart). A failed page is no longer a dead end that only a sort/filter
 *     change could clear — on a TV that is several remote presses. After the
 *     budget the list stays blocked with the error visible.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// One initial request plus two retries: enough to ride out a TV's flaky Wi-Fi
// without turning a persistent failure into a request loop.
const MAX_PAGE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

export function usePagedList({ fetchPage, requestKey }) {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const requestIdRef = useRef(0);

  // Every id this request identity has ever produced. The old dedupe rescanned
  // `items`, which was enough to avoid appending a row twice but could not
  // distinguish "the page was genuinely empty" from "the page repeated what we
  // already hold" — and that distinction is exactly the no-progress signal the
  // stop condition below needs. Seeded from page 1 by the reset effect.
  const seenIdsRef = useRef(new Set());

  // A page-N failure is retried from here, never from a consumer's trigger.
  // Without `retryPendingRef`, `setLoadingMore(false)` in the failure path
  // re-armed the grid's observer and the retry became an immediate loop with
  // no backoff. The flag makes every churn trigger a no-op while the timer
  // is pending.
  const blockedRef = useRef(false);
  const attemptsRef = useRef(0);
  const retryPendingRef = useRef(false);
  const retryTimerRef = useRef(null);

  // Callers write `fetchPage` inline, so it is a new function on every render.
  // Holding it in a ref lets the reset effect key on `requestKey` alone —
  // otherwise the list would be refetched every render. The ref is written by
  // an effect declared *before* the reset effect, so on a commit where both
  // run, the reset sees the current closure. Same shape as useKeyHandler's
  // onBackRef.
  const fetchPageRef = useRef(fetchPage);
  useEffect(() => { fetchPageRef.current = fetchPage; });

  // Latest `loadMore` for the retry timer. The timer fires between renders,
  // when the closure that scheduled it may be stale (its `loadingMore` is
  // still true); the ref always points at the current one.
  const loadMoreRef = useRef(null);

  // ── Reset to page 1 whenever the request identity changes ─
  useEffect(() => {
    const reqId = ++requestIdRef.current;
    let cancelled = false;

    // The timer belongs to the identity being replaced. Leaving it armed let
    // it fire `loadMore` against the new list, and its page-N failure path
    // then blocked a request identity that had never failed.
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    retryPendingRef.current = false;
    attemptsRef.current = 0;
    seenIdsRef.current = new Set();
    blockedRef.current = false;

    setLoading(true);
    setError(null);
    setItems([]);
    setPage(1);
    setTotal(0);
    // Both of these belong to the request identity being replaced. Without
    // the first, a page that was in flight when the reset happened reached
    // `finally` with a stale id, skipped its `setLoadingMore(false)`, and
    // left infinite scroll dead (and the spinner up) until the view
    // remounted. The second gives the new identity a fresh error budget.
    setLoadingMore(false);

    fetchPageRef.current(1)
      .then(data => {
        if (cancelled || reqId !== requestIdRef.current) return;
        seenIdsRef.current = new Set(data.items.map(it => it.id));
        setItems(data.items);
        setTotal(data.total);
        setLoading(false);
      })
      .catch(e => {
        if (cancelled || reqId !== requestIdRef.current) return;
        setError(e.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      retryPendingRef.current = false;
    };
  }, [requestKey]);

  // ── Load the next page ────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (loadingMore || loading || blockedRef.current || retryPendingRef.current) return;
    if (items.length >= total && total > 0) return;

    // Reads the id, never bumps it. Only the reset effect above bumps, which
    // is what makes an in-flight page harmless once the list has moved on.
    const reqId = requestIdRef.current;
    const nextPage = page + 1;

    setLoadingMore(true);
    try {
      const data = await fetchPageRef.current(nextPage);
      if (reqId !== requestIdRef.current) return;

      // Collect before touching state: the seen-set is a ref, and refs must
      // not be mutated inside a state updater (StrictMode runs updaters
      // twice). The set also dedupes within the page itself.
      const fresh = [];
      for (const it of data.items) {
        if (seenIdsRef.current.has(it.id)) continue;
        seenIdsRef.current.add(it.id);
        fresh.push(it);
      }

      if (fresh.length === 0) {
        // No progress: this page added nothing. Treat it as the end for this
        // request identity — see the header. A truthy count is still worth
        // taking, so the UI's "n of total" does not stay stale forever.
        if (data.total) setTotal(data.total);
        blockedRef.current = true;
        return;
      }

      attemptsRef.current = 0;
      setError(null);
      setItems(prev => [...prev, ...fresh]);
      setPage(nextPage);
      // Only when truthy: a page that reports 0 must not wipe a known count.
      if (data.total) setTotal(data.total);
    } catch (e) {
      if (reqId !== requestIdRef.current) return;
      setError(e.message);
      attemptsRef.current += 1;
      if (attemptsRef.current < MAX_PAGE_ATTEMPTS) {
        retryPendingRef.current = true;
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          retryPendingRef.current = false;
          // The timer can outlive the identity only if the reset cleanup
          // somehow ran early; the id check makes that harmless anyway.
          if (reqId === requestIdRef.current) loadMoreRef.current?.();
        }, RETRY_DELAY_MS);
      } else {
        // Budget spent. Stay blocked with the error on screen; a sort/filter
        // change is the manual way out.
        blockedRef.current = true;
      }
    } finally {
      if (reqId === requestIdRef.current) setLoadingMore(false);
    }
  }, [loadingMore, loading, items.length, total, page]);

  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);

  // The grid renders an end-of-list marker off this and unmounts its sentinel.
  const exhausted = total > 0 && items.length >= total;

  return { items, total, page, loading, loadingMore, error, exhausted, loadMore };
}
