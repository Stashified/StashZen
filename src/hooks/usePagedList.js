/**
 * usePagedList: the pagination state machine the list views share
 *
 * The request (page size, which `controls` go into it) and *when* to ask for
 * more stay with the caller, the grid watches an IntersectionObserver
 * sentinel, the others the focused index. The hook owns the identical part:
 *
 *   - the request-id guard, so a page resolving after a reset or sort change
 *     cannot write its rows into the new list
 *   - the dedupe-by-id append, because Stash's ordering can shift between page
 *     requests and a row can legitimately appear twice
 *   - the "we already hold every row" stop
 *   - the in-flight guard, which keeps two triggers off the same page
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
 * `fetchPage(page)` takes a 1-based page and resolves to `{ items, total }`
 * (whatever entity the caller lists); the page size is baked into the closure.
 *
 * `requestKey` is the caller's *request identity*: change it and the list
 * resets to page 1. Build it with `pageRequestKey` from everything that
 * belongs to the request, never from `fetchPage` or the page number.
 *
 * Two stops beyond "every row is held":
 *
 *   - **No progress.** A page yielding no new ids ends the list. Stash's count
 *     and rows can disagree while a scan runs or a library shrinks; without
 *     this each empty page bumped `page` and chained requests. `usePlayQueue`
 *     tolerates duplicates because playback must keep moving; a listing stops
 *     at the first no-progress page.
 *   - **A failed page.** Shown and retried automatically with a bounded budget
 *     (MAX_PAGE_ATTEMPTS, RETRY_DELAY_MS apart), so a TV user need not change
 *     sort/filter (several remote presses) to get out. After the budget the
 *     list stays blocked with the error visible.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { registerFocusListing } from '../utils/focus.js';
import { onRowPatch, onRowRemove } from '../utils/rowPatches.js';

// One initial request plus two retries: enough to ride out a TV's flaky Wi-Fi
// without turning a persistent failure into a request loop.
const MAX_PAGE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

export function usePagedList({ fetchPage, requestKey, focusPrefix = null, entity = null }) {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // Page 1 failed and a retry is on its way. Without it the TV shows a plain
  // spinner for the whole retry budget and reads as hung.
  const [retrying, setRetrying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  // The no-progress stop is a *successful* end: the server answered with
  // nothing new. A separate flag keeps it off the error path and lets grids
  // draw their end marker instead of leaving the sentinel up forever.
  const [ended, setEnded] = useState(false);

  const requestIdRef = useRef(0);

  // Every id this request identity has produced. Rescanning `items` avoided
  // duplicate appends but could not tell "genuinely empty page" from "repeated
  // what we hold", the distinction the no-progress stop needs.
  const seenIdsRef = useRef(new Set());

  // A page-N failure is retried from here, never from a consumer's trigger:
  // without `retryPendingRef`, `setLoadingMore(false)` re-armed the observer
  // and the retry became an immediate loop with no backoff.
  const blockedRef = useRef(false);
  const attemptsRef = useRef(0);
  const retryPendingRef = useRef(false);
  const retryTimerRef = useRef(null);

  // Re-entrancy guard held in a ref, not `loadingMore` state: two triggers can
  // ask for the next page in the same tick (the sentinel observer and a focus
  // restore paging forward), and a state update is invisible to the second.
  // Both then fetched the same page, and the second hit the no-progress stop:
  // a 1,892-row library printed "40 performers" and could never page again.
  //
  // Holds the *request id that owns the fetch*, not a boolean: a boolean
  // outlived its identity, so page 3 of the old sort blocked the new one, and
  // its stale settle cleared the flag without re-arming the sentinel. The guard
  // below blocks only an owner that is also the current identity.
  const inFlightRef = useRef(null);

  // What `loadMore` may act on, read from refs rather than the render closure.
  // The guard above stops simultaneous triggers, not one queued by an older
  // render: the sentinel observer is rebuilt every page, and a callback queued
  // just before still holds the previous `page`, asking for the page that just
  // arrived. Current refs make it ask for the next page, or nothing at all.
  const pageRef = useRef(1);
  const itemsLenRef = useRef(0);
  const totalRef = useRef(0);
  const loadingRef = useRef(true);
  // The current identity's abort controller. A replaced identity's requests
  // must free their sockets now: on a slow server, superseded page 1s queue
  // the newest request behind them.
  const abortRef = useRef(null);

  // Callers write `fetchPage` inline, so it is new every render. Holding it in
  // a ref lets the reset effect key on `requestKey` alone. This effect is
  // declared before the reset effect, so on a shared commit the reset sees the
  // current closure.
  const fetchPageRef = useRef(fetchPage);
  useEffect(() => { fetchPageRef.current = fetchPage; });

  // A write elsewhere publishes the fields it changed; patch the row in place
  // so the card is current without a refetch (which would reset focus).
  useEffect(() => {
    if (!entity) return undefined;
    const offPatch = onRowPatch(entity, (id, patch) => {
      setItems((prev) => {
        let changed = false;
        const next = prev.map((it) => {
          if (String(it.id) !== id) return it;
          changed = true;
          return { ...it, ...patch };
        });
        return changed ? next : prev;
      });
    });
    // Deleting a row this list has loaded must also drop its count, or the
    // grid keeps a sentinel for a page that no longer exists.
    const offRemove = onRowRemove(entity, (id) => {
      if (!seenIdsRef.current.has(id)) return;
      seenIdsRef.current.delete(id);
      setItems((prev) => {
        const next = prev.filter(it => String(it.id) !== id);
        if (next.length === prev.length) return prev;
        itemsLenRef.current = next.length;
        return next;
      });
      setTotal((prev) => {
        if (!prev) return prev;
        const next = Math.max(0, prev - 1);
        totalRef.current = next;
        return next;
      });
    });
    return () => {
      offPatch();
      offRemove();
    };
  }, [entity]);

  // Latest `loadMore` for the retry timer, which fires between renders holding
  // a stale closure.
  const loadMoreRef = useRef(null);

  // ── Reset to page 1 whenever the request identity changes ─
  useEffect(() => {
    const reqId = ++requestIdRef.current;
    let cancelled = false;

    // The timer belongs to the replaced identity; left armed it fired against
    // the new list and blocked an identity that had never failed.
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    retryPendingRef.current = false;
    attemptsRef.current = 0;
    seenIdsRef.current = new Set();
    blockedRef.current = false;
    // Synchronously, before any stale trigger can read them.
    pageRef.current = 1;
    itemsLenRef.current = 0;
    totalRef.current = 0;
    loadingRef.current = true;
    abortRef.current?.abort();
    abortRef.current = typeof AbortController === 'function' ? new AbortController() : null;
    const { signal } = abortRef.current || {};

    setLoading(true);
    setRetrying(false);
    setError(null);
    setItems([]);
    setPage(1);
    setTotal(0);
    setEnded(false);
    // Both belong to the replaced identity: without the first, an in-flight
    // page skipped `setLoadingMore(false)` and left infinite scroll dead; the
    // second gives the new identity a fresh error budget.
    setLoadingMore(false);

    // Page 1 gets the same bounded retry as page N: its failure used to be a
    // dead end only a remount cleared. The error is not shown until the budget
    // is spent, a retry already on its way is not something to read about.
    const attemptFirstPage = () => {
      fetchPageRef.current(1, signal)
        .then(data => {
          if (cancelled || reqId !== requestIdRef.current) return;
          attemptsRef.current = 0;
          setRetrying(false);
          seenIdsRef.current = new Set(data.items.map(it => it.id));
          itemsLenRef.current = data.items.length;
          totalRef.current = data.total;
          loadingRef.current = false;
          setItems(data.items);
          setTotal(data.total);
          setLoading(false);
        })
        .catch(e => {
          if (cancelled || reqId !== requestIdRef.current) return;
          // A reset aborted a request this identity then joined through
          // listCache's in-flight map. That abort is not this attempt's verdict:
          // our own signal is live, so start again without spending the budget.
          if (e?.name === 'AbortError') {
            attemptFirstPage();
            return;
          }
          attemptsRef.current += 1;
          if (attemptsRef.current >= MAX_PAGE_ATTEMPTS) {
            // Block further pages too: page 2 of a list whose page 1 never
            // arrived would be a partial list with a hole at the top.
            blockedRef.current = true;
            loadingRef.current = false;
            setRetrying(false);
            setError(e.message);
            setLoading(false);
            return;
          }
          setRetrying(true);
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            if (cancelled || reqId !== requestIdRef.current) return;
            attemptFirstPage();
          }, RETRY_DELAY_MS);
        });
    };
    attemptFirstPage();

    return () => {
      cancelled = true;
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      retryPendingRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [requestKey]);

  // ── Load the next page ────────────────────────────────────
  const loadMore = useCallback(async () => {
    // Reads the id, never bumps it. Only the reset effect above bumps, which
    // is what makes an in-flight page harmless once the list has moved on.
    const reqId = requestIdRef.current;

    // The refs close both windows: two triggers in one tick (owner check) and
    // a trigger queued by an older render (refs below). The committed pair is
    // a conservative extra, a stale-true `loading` only defers one trigger.
    //
    // The owner check is deliberately `===`: a replaced identity must not block
    // the new one, and its `finally` clears the flag only when it still owns it.
    if (inFlightRef.current === reqId || loadingMore || loading || loadingRef.current
        || blockedRef.current || retryPendingRef.current) return false;
    if (itemsLenRef.current >= totalRef.current && totalRef.current > 0) return false;

    const nextPage = pageRef.current + 1;

    inFlightRef.current = reqId;
    setLoadingMore(true);
    try {
      const data = await fetchPageRef.current(nextPage, abortRef.current?.signal);
      if (reqId !== requestIdRef.current) return true;

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
        // No progress: this page added nothing, so treat it as the end for this
        // identity. `total` becomes what we hold, the server's higher count
        // would promise rows the list has stopped fetching, and `ended` lets
        // the grid unmount the sentinel and draw its end marker.
        blockedRef.current = true;
        totalRef.current = itemsLenRef.current;
        setTotal(itemsLenRef.current);
        setEnded(true);
        return true;
      }

      attemptsRef.current = 0;
      setError(null);
      itemsLenRef.current += fresh.length;
      pageRef.current = nextPage;
      setItems(prev => [...prev, ...fresh]);
      setPage(nextPage);
      // Only when truthy: a page that reports 0 must not wipe a known count.
      if (data.total) {
        totalRef.current = data.total;
        setTotal(data.total);
      }
    } catch (e) {
      // An aborted request was cancelled on purpose (a new identity, or an
      // unmount); its failure is not something to report or retry.
      if (reqId !== requestIdRef.current || e?.name === 'AbortError') return true;
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
      // Only when this request still owns the slot; a reset may have started a
      // new fetch whose guard an unconditional clear would drop.
      if (inFlightRef.current === reqId) inFlightRef.current = null;
      if (reqId === requestIdRef.current) setLoadingMore(false);
    }
    // `true` means a fetch was started. `focus.js` counts its page budget off
    // this: an early return (blocked, retrying, already loading) is not a page
    // it may spend, or a restore can burn all twelve on no-ops.
    return true;
    // `loading` is not read in the body but is a dependency because the grids
    // wire their sentinel observer to this callback's identity: on the first
    // render there is no sentinel, so it must change when page 1 lands.
  }, [loadingMore, loading]);

  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);

  // The grid draws an end marker off this and unmounts its sentinel; `ended`
  // covers the no-progress stop, where the held rows are the whole list.
  const exhausted = ended || (total > 0 && items.length >= total);

  // ── A focus restore can ask this listing for more rows ────
  // Back out of a filtered listing remounts the origin grid, which fetches only
  // page 1; a card from a later page would never come back. The registered
  // listing pages forward until it exists, see utils/focus.js.
  //
  // The driver reads paging state through a ref because `loadMore` is replaced
  // every render (its guards close over the current page), yet the registered
  // object must stay stable. The snapshot refreshes after each render, before
  // any restore's next attempt.
  const driverStateRef = useRef(null);
  useEffect(() => {
    driverStateRef.current = {
      canLoad: !loading && !loadingMore && !exhausted && !error,
      loadMore,
    };
  });
  useEffect(() => {
    if (!focusPrefix) return undefined;
    return registerFocusListing(focusPrefix, {
      loadMore: () => driverStateRef.current?.loadMore(),
      canLoad: () => !!driverStateRef.current?.canLoad,
      pending: false,
    });
  }, [focusPrefix]);

  return {
    items, total, page, loading, retrying, loadingMore, error, exhausted, loadMore,
  };
}
