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
 *     deps: [sort, order, objectFilter, searchQuery],
 *   });
 *
 * `fetchPage(page)` takes a 1-based page number and resolves to
 * `{ items, total }` — `items` whatever entity the caller is listing, so the
 * hook does not need to know that scenes call their array `videos`. The page
 * size belongs to the caller, baked into the closure.
 *
 * `deps` is the caller's *request identity*: everything that should reset the
 * list to page 1. It must be the same length on every render (it is spread
 * into the effect's dependency array), and it must not contain `fetchPage` —
 * callers pass inline arrows, and the hook holds the current one in a ref
 * precisely so that a new function identity does not throw the list away.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function usePagedList({ fetchPage, deps = [] }) {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const requestIdRef = useRef(0);

  // A failed page-N request must not be retried on its own. The grid's
  // IntersectionObserver re-arms when `loadMore`'s identity changes, and
  // `setLoadingMore(false)` in the failure path was enough to do that: with
  // the sentinel still on screen the observer's initial entry asked again,
  // immediately or after the 12 s timeout, forever, with no error visible
  // while rows were on screen. One failure per request identity is the
  // honest budget; a sort/filter/search change is the retry.
  const blockedRef = useRef(false);

  // Callers write `fetchPage` inline, so it is a new function on every render.
  // Holding it in a ref lets the reset effect below key on `deps` alone —
  // otherwise the list would be refetched every render. The ref is written by
  // an effect declared *before* the reset effect, so on a commit where both
  // run, the reset sees the current closure. Same shape as useKeyHandler's
  // onBackRef.
  const fetchPageRef = useRef(fetchPage);
  useEffect(() => { fetchPageRef.current = fetchPage; });

  // ── Reset to page 1 whenever the request identity changes ─
  useEffect(() => {
    const reqId = ++requestIdRef.current;
    let cancelled = false;

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
    blockedRef.current = false;

    fetchPageRef.current(1)
      .then(data => {
        if (cancelled || reqId !== requestIdRef.current) return;
        setItems(data.items);
        setTotal(data.total);
        setLoading(false);
      })
      .catch(e => {
        if (cancelled || reqId !== requestIdRef.current) return;
        setError(e.message);
        setLoading(false);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // ── Load the next page ────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (loadingMore || loading || blockedRef.current) return;
    if (items.length >= total && total > 0) return;

    // Reads the id, never bumps it. Only the reset effect above bumps, which
    // is what makes an in-flight page harmless once the list has moved on.
    const reqId = requestIdRef.current;
    const nextPage = page + 1;

    setLoadingMore(true);
    try {
      const data = await fetchPageRef.current(nextPage);
      if (reqId !== requestIdRef.current) return;

      setItems(prev => {
        const seen = new Set(prev.map(it => it.id));
        return [...prev, ...data.items.filter(it => !seen.has(it.id))];
      });
      setPage(nextPage);
      // Only when truthy: a page that reports 0 must not wipe a known count.
      if (data.total) setTotal(data.total);
    } catch (e) {
      if (reqId === requestIdRef.current) {
        setError(e.message);
        blockedRef.current = true;
      }
    } finally {
      if (reqId === requestIdRef.current) setLoadingMore(false);
    }
  }, [loadingMore, loading, items.length, total, page]);

  // The grid renders an end-of-list marker off this and unmounts its sentinel.
  const exhausted = total > 0 && items.length >= total;

  return { items, total, page, loading, loadingMore, error, exhausted, loadMore };
}
