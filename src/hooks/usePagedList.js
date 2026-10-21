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
import { registerFocusListing } from '../utils/focus.js';

// One initial request plus two retries: enough to ride out a TV's flaky Wi-Fi
// without turning a persistent failure into a request loop.
const MAX_PAGE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

export function usePagedList({ fetchPage, requestKey, focusPrefix = null }) {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  // The no-progress stop is a *successful* end, not a failure: the server
  // answered, it just had nothing new. A separate flag keeps it off the error
  // path and lets the grids draw their end marker instead of leaving the
  // sentinel mounted forever with a stale "n of total" above it.
  const [ended, setEnded] = useState(false);

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

  // Re-entrancy guard held in a ref, not in `loadingMore` state. Two triggers
  // can ask for the next page in the same tick — the grid's sentinel observer
  // and a focus restore paging the listing forward (utils/focus.js) — and a
  // state update is invisible to the second call, so both used to fetch the
  // same page. Both callers then receive the same rows (the list cache shares
  // the in-flight request), the first appends them, and the second hits the
  // no-progress stop below: it rewrote the total to the rows held at that
  // moment and marked the list exhausted, so a 1,892-row library printed
  // "40 performers" and could never page again. Reported from the TV on
  // 2026-10-20, right after Back restored a card from deep in the listing.
  //
  // Holds the *request id that owns the fetch*, not a boolean. A boolean
  // outlived the identity it belonged to: page 3 of one sort could still be
  // running when the user changed the sort, and the new identity's first
  // trigger then refused to fetch because the old request "held" the flag.
  // When the old request settled it cleared the flag without a state change
  // (its id was stale), so nothing re-armed the sentinel and paging stalled
  // until the next scroll. The guard below blocks only an owner that is also
  // the current identity.
  const inFlightRef = useRef(null);

  // What `loadMore` is allowed to act on, read from refs rather than from the
  // render closure. The guard above stops two triggers *at the same time*;
  // it does not stop a trigger that was queued by an older render — the
  // sentinel observer is rebuilt after every page, and a callback queued just
  // before the rebuild still holds the previous render's `page`. That stale
  // call passed a false `loadingMore`, asked for the page that had just
  // arrived, and hit the same no-progress stop from the other side (the
  // performer harness caught it as "80 performers" after a third-page
  // restore). Reading the current page/count means a late trigger asks for
  // the *next* page or, once every row is held, for nothing at all.
  const pageRef = useRef(1);
  const itemsLenRef = useRef(0);
  const totalRef = useRef(0);
  const loadingRef = useRef(true);

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
    // Synchronously, before any stale trigger can read them — see the block
    // comment where these refs are declared.
    pageRef.current = 1;
    itemsLenRef.current = 0;
    totalRef.current = 0;
    loadingRef.current = true;

    setLoading(true);
    setError(null);
    setItems([]);
    setPage(1);
    setTotal(0);
    setEnded(false);
    // Both of these belong to the request identity being replaced. Without
    // the first, a page that was in flight when the reset happened reached
    // `finally` with a stale id, skipped its `setLoadingMore(false)`, and
    // left infinite scroll dead (and the spinner up) until the view
    // remounted. The second gives the new identity a fresh error budget.
    setLoadingMore(false);

    // Page 1 gets the same bounded retry as page N. Its failure used to be a
    // dead end: the error said there was nothing to press, and only leaving
    // and re-entering the tab (a remount) tried again. The error is not shown
    // until the budget is spent, because a retry that is already on its way
    // is not a failure the user should have to read about — the loading
    // state stays up instead.
    const attemptFirstPage = () => {
      fetchPageRef.current(1)
        .then(data => {
          if (cancelled || reqId !== requestIdRef.current) return;
          attemptsRef.current = 0;
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
          attemptsRef.current += 1;
          if (attemptsRef.current >= MAX_PAGE_ATTEMPTS) {
            // Block further pages too: page 2 of a list whose page 1 never
            // arrived would be a partial list with a hole at the top.
            blockedRef.current = true;
            loadingRef.current = false;
            setError(e.message);
            setLoading(false);
            return;
          }
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
    };
  }, [requestKey]);

  // ── Load the next page ────────────────────────────────────
  const loadMore = useCallback(async () => {
    // Reads the id, never bumps it. Only the reset effect above bumps, which
    // is what makes an in-flight page harmless once the list has moved on.
    const reqId = requestIdRef.current;

    // `loading` and `loadingMore` are the *committed* state; the refs are what
    // close both windows — two triggers in one tick (the owner check) and a
    // trigger queued by an older render (the refs below). The committed pair
    // stays as a conservative extra: a stale-true `loading` only defers one
    // trigger, and a stale-false one is covered by the ref.
    //
    // The owner check is deliberately `===`: a fetch belonging to a *replaced*
    // identity must not block the new one. Its `finally` below only clears the
    // flag when it still owns it, so it cannot swallow the new request's slot.
    if (inFlightRef.current === reqId || loadingMore || loading || loadingRef.current
        || blockedRef.current || retryPendingRef.current) return false;
    if (itemsLenRef.current >= totalRef.current && totalRef.current > 0) return false;

    const nextPage = pageRef.current + 1;

    inFlightRef.current = reqId;
    setLoadingMore(true);
    try {
      const data = await fetchPageRef.current(nextPage);
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
        // No progress: this page added nothing. Treat it as the end for this
        // request identity — see the header. `total` becomes what we actually
        // hold: keeping the server's higher count would leave "n of total"
        // promising rows the list has stopped fetching, and `ended` is what
        // lets the grid unmount the sentinel and draw its end marker.
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
      if (reqId !== requestIdRef.current) return true;
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
      // Only when this request still owns the slot. A reset may have let the
      // new identity start its own fetch while this one was running; an
      // unconditional clear here would drop *that* guard and let a second
      // trigger duplicate it.
      if (inFlightRef.current === reqId) inFlightRef.current = null;
      if (reqId === requestIdRef.current) setLoadingMore(false);
    }
    // `true` means a fetch was started. `focus.js` counts its page budget off
    // this: an early return (blocked, retrying, already loading) is not a page
    // it may spend, or a restore can burn all twelve on no-ops.
    return true;
    // `loading` is not read in the body — it is a dependency because the grids
    // wire their sentinel observer to this callback's identity. On the first
    // render the component is still the spinner and has no sentinel to
    // observe; the observer is attached when this identity changes as page 1
    // lands. Its other transition points (a reset, and every page's
    // loadingMore flip) keep the sentinel re-armed.
  }, [loadingMore, loading]);

  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);

  // The grid renders an end-of-list marker off this and unmounts its sentinel.
  // `ended` covers the no-progress stop, where the held rows are the whole
  // list even though the server's count said otherwise.
  const exhausted = ended || (total > 0 && items.length >= total);

  // ── A focus restore can ask this listing for more rows ────
  // Back out of a filtered listing remounts the origin grid, which fetches
  // page 1 only; a card from a later page would otherwise never come back and
  // focus would fall to the first card. `focusByIdWhenReady` pages the
  // registered listing forward one page at a time until the card exists — see
  // utils/focus.js. The section's own prefixes are the lookup keys.
  //
  // Reading the paging state through a ref, not capturing it: `loadMore` is
  // replaced on every render (its guards close over the current page), and
  // the registered object has to stay stable or the restore would hold a
  // stale listing. The state snapshot is refreshed after each render, before
  // any restore's next attempt (see RETRY_MS in utils/focus.js).
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

  return { items, total, page, loading, loadingMore, error, exhausted, loadMore };
}
