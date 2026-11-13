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
import { dataSourceKey } from '../utils/settings.js';

// One initial request plus two retries: enough to ride out a TV's flaky Wi-Fi
// without turning a persistent failure into a request loop.
const MAX_PAGE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;
// A listCache abort is not this attempt's verdict, but a fetch layer that
// aborts every time must still terminate. Small, since a legitimate cache
// abort happens once per reset, not in a loop.
const MAX_ABORT_RETRIES = 3;

// The last page 1 each listing showed, kept *outside* listCache on purpose:
// moving between tabs clears that cache so a server-side change is read again,
// but the cleared rows are exactly what should stay on screen while the new
// answer is in flight. The fresh page 1 always replaces them; this is only
// what the eye sees until it lands. Bounded like the list cache.
const STALE_MAX = 24;
const stalePage1 = new Map();

function stalePageKey(focusPrefix, entity, requestKey, variant) {
  // NUL-separated like listCacheKey: no value can forge a part boundary.
  //
  // `focusPrefix` is the listing's identity, and it is load-bearing: the
  // browse tabs pass no `entity`, and Performers/Tags/Studios/Groups share one
  // requestKey (name/asc) exactly as Galleries/Images share another. Without
  // it a tab switch seeded the new tab with the previous tab's rows, and Enter
  // opened one of them.
  //
  // `variant` separates one listing fetched with a different query shape: the
  // Carousel's scenes carry `details` and a grid's do not, so their seeds must
  // not stand in for each other.
  return [dataSourceKey(), focusPrefix || '', entity || '', variant || '', requestKey].join('\u0000');
}

function rememberPage1(key, items, total) {
  stalePage1.delete(key);
  stalePage1.set(key, { items, total });
  while (stalePage1.size > STALE_MAX) {
    stalePage1.delete(stalePage1.keys().next().value);
  }
}

export function usePagedList({
  fetchPage, requestKey, focusPrefix = null, entity = null, seedVariant = '',
}) {
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

  // The rows on screen came from the stale page-1 seed and the fresh page 1 is
  // still in flight. A focus restore that finds its card inside those rows must
  // not call that a landing; see `revalidating` in the driver registration.
  const seededRef = useRef(false);

  // A page-N failure is retried from here, never from a consumer's trigger:
  // without `retryPendingRef`, `setLoadingMore(false)` re-armed the observer
  // and the retry became an immediate loop with no backoff.
  const blockedRef = useRef(false);
  const attemptsRef = useRef(0);
  const retryPendingRef = useRef(false);
  const retryTimerRef = useRef(null);
  // The delete backfill runs on a timer too; left untracked it fired after an
  // identity change or unmount and fetched against the wrong list.
  const backfillTimerRef = useRef(null);
  // Best effort: also re-armed when a page that was already in flight lands,
  // since that page was fetched against the offsets from before the delete.
  const scheduleBackfill = () => {
    clearTimeout(backfillTimerRef.current);
    backfillTimerRef.current = setTimeout(() => {
      backfillTimerRef.current = null;
      loadMoreRef.current?.();
    }, 0);
  };

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
  // The page size `fetchPage` bakes in, learned from the widest page seen.
  const pageSizeRef = useRef(0);
  // A delete shifts later rows up, so the held rows stop ending on a page
  // boundary and the next page would start one row late, skipping the row
  // that moved. This is the held count at the delete: the server index of the
  // first missing row, which is the page the next fetch must reseat. A count
  // rather than a flag, because a page already in flight lands against the
  // old offsets and moves the boundary out from under a recount. -1 = no seam.
  const seamRef = useRef(-1);
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
      // Synchronously: the backfill runs on a timer and must not wait for
      // React to render this state.
      itemsLenRef.current = Math.max(0, itemsLenRef.current - 1);
      if (totalRef.current > 0) totalRef.current = Math.max(0, totalRef.current - 1);
      setItems((prev) => {
        const next = prev.filter(it => String(it.id) !== id);
        itemsLenRef.current = next.length;
        return next.length === prev.length ? prev : next;
      });
      setTotal((prev) => (prev ? Math.max(0, prev - 1) : prev));
      // Rows remain unloaded, so there is a seam. Keep the earliest: two
      // deletes before the fetch both have to be covered. The call is best
      // effort; the count is what keeps the next request correct.
      if (itemsLenRef.current < totalRef.current) {
        seamRef.current = seamRef.current >= 0
          ? Math.min(seamRef.current, itemsLenRef.current)
          : itemsLenRef.current;
        scheduleBackfill();
      }
    });
    return () => {
      offPatch();
      offRemove();
    };
  }, [entity]);

  // Mirrors the rows on screen for the reset effect, which keys on
  // `requestKey` alone. Declared here so it updates before that effect runs.
  const itemsStateRef = useRef(items);
  useEffect(() => { itemsStateRef.current = items; }, [items]);

  // Latest `loadMore` for the retry timer, which fires between renders holding
  // a stale closure.
  const loadMoreRef = useRef(null);

  // ── Reset to page 1 whenever the request identity changes ─
  useEffect(() => {
    const reqId = ++requestIdRef.current;
    let cancelled = false;

    // The outgoing identity's rows and count, read before the refs below are
    // zeroed. They stay on screen while the new page 1 is fetched: a search
    // commit changes the identity on every debounce pause, and blanking the
    // grid each time read as the app reloading per keystroke.
    const shown = itemsStateRef.current;
    const shownTotal = totalRef.current;

    // The timer belongs to the replaced identity; left armed it fired against
    // the new list and blocked an identity that had never failed.
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    retryPendingRef.current = false;
    // The delete backfill and its seam belong to the old identity: left set,
    // the new list would fetch a page picked for a seam it does not have.
    clearTimeout(backfillTimerRef.current);
    backfillTimerRef.current = null;
    seamRef.current = -1;
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

    // The previous visit's page 1 wins over the rows on screen: it was read
    // for this exact request. Either way the fresh page 1 replaces them, so
    // these are only what the eye sees until it lands, and neither is
    // remembered under `key`. Seeding the refs keeps `loadMore`'s arithmetic
    // honest meanwhile.
    const key = stalePageKey(focusPrefix, entity, requestKey, seedVariant);
    const seed = stalePage1.get(key);
    const carried = seed?.items || shown;
    const carriedTotal = seed?.total ?? shownTotal;
    seededRef.current = carried.length > 0;
    seenIdsRef.current = new Set(carried.map(it => it.id));
    itemsLenRef.current = carried.length;
    totalRef.current = carriedTotal;

    setLoading(true);
    setRetrying(false);
    setError(null);
    setItems(carried);
    setPage(1);
    setTotal(carriedTotal);
    setEnded(false);
    // Both belong to the replaced identity: without the first, an in-flight
    // page skipped `setLoadingMore(false)` and left infinite scroll dead; the
    // second gives the new identity a fresh error budget.
    setLoadingMore(false);

    // Page 1 gets the same bounded retry as page N: its failure used to be a
    // dead end only a remount cleared. The error is not shown until the budget
    // is spent, a retry already on its way is not something to read about.
    let abortRetries = 0;
    const attemptFirstPage = () => {
      fetchPageRef.current(1, signal)
        .then(data => {
          if (cancelled || reqId !== requestIdRef.current) return;
          attemptsRef.current = 0;
          abortRetries = 0;
          setRetrying(false);
          if (data.items.length > pageSizeRef.current) {
            pageSizeRef.current = data.items.length;
          }
          seenIdsRef.current = new Set(data.items.map(it => it.id));
          itemsLenRef.current = data.items.length;
          totalRef.current = data.total;
          // Page 1 replaces the whole list, so a delete that landed while it
          // was in flight has no row left to reseat: the seam is spent.
          seamRef.current = -1;
          loadingRef.current = false;
          rememberPage1(key, data.items, data.total);
          setItems(data.items);
          setTotal(data.total);
          setLoading(false);
        })
        .catch(e => {
          if (cancelled || reqId !== requestIdRef.current) return;
          // A reset aborted a request this identity then joined through
          // listCache's in-flight map. That abort is not this attempt's verdict:
          // our own signal is live, so start again without spending the budget.
          // If our own signal did abort, the identity is dead and the retry
          // would spin; and a fetch layer that aborts unconditionally still
          // has to terminate, so the re-issue is capped.
          // `signal` is undefined when AbortController itself is unavailable
          // (see abortRef above), so guard the read.
          if (e?.name === 'AbortError' && !signal?.aborted) {
            if (abortRetries < MAX_ABORT_RETRIES) {
              abortRetries += 1;
              attemptFirstPage();
              return;
            }
          }
          attemptsRef.current += 1;
          if (attemptsRef.current >= MAX_PAGE_ATTEMPTS) {
            // Block further pages too: page 2 of a list whose page 1 never
            // arrived would be a partial list with a hole at the top.
            blockedRef.current = true;
            loadingRef.current = false;
            // Drop the carried rows: every consumer shows this error only when
            // the list is empty, so leaving them showed the replaced query's
            // results as if they were the new one's, with no error at all when
            // they filled the old total.
            seenIdsRef.current = new Set();
            itemsLenRef.current = 0;
            totalRef.current = 0;
            seededRef.current = false;
            setRetrying(false);
            // A spent abort budget would otherwise surface "Aborted", which
            // reads as a crash rather than a list that did not load.
            setError(e?.name === 'AbortError'
              ? 'The list did not load.'
              : e?.message || 'The list did not load.');
            setLoading(false);
            setItems([]);
            setTotal(0);
            setEnded(true);
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
      clearTimeout(backfillTimerRef.current);
      backfillTimerRef.current = null;
      retryPendingRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // `entity`, `focusPrefix` and `seedVariant` are part of the stale-page key;
    // all are fixed per component, so including them costs no extra resets.
  }, [requestKey, entity, focusPrefix, seedVariant]);

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
    if (seamRef.current < 0 && itemsLenRef.current >= totalRef.current
        && totalRef.current > 0) return false;

    let nextPage = pageRef.current + 1;
    // The page covering the seam, not the one after the last: the delete pulled
    // every later row up by one. Consumed here, restored if the fetch fails.
    const seam = seamRef.current;
    let consumedSeam = -1;
    if (seam >= 0) {
      const size = pageSizeRef.current;
      if (size > 0) {
        nextPage = Math.floor(seam / size) + 1;
        consumedSeam = seam;
        seamRef.current = -1;
      }
    }

    inFlightRef.current = reqId;
    setLoadingMore(true);
    try {
      const data = await fetchPageRef.current(nextPage, abortRef.current?.signal);
      if (reqId !== requestIdRef.current) return true;
      if (data.items.length > pageSizeRef.current) {
        pageSizeRef.current = data.items.length;
      }

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
        //
        // The page answered, so a retried page's earlier error is resolved;
        // left set, the list reports "ended" and a stale failure at once.
        setError(null);
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
      // A delete landed while this page was in flight. Its rows start at the
      // seam, so they bridge the gap rather than reseating the old page; the
      // boundary is now whatever is still missing.
      if (seamRef.current >= 0) {
        seamRef.current = itemsLenRef.current < totalRef.current
          ? itemsLenRef.current
          : -1;
      }
    } catch (e) {
      // An aborted request was cancelled on purpose (a new identity, or an
      // unmount); its failure is not something to report or retry.
      if (reqId !== requestIdRef.current || e?.name === 'AbortError') return true;
      setError(e.message);
      attemptsRef.current += 1;
      if (attemptsRef.current < MAX_PAGE_ATTEMPTS) {
        // The retry must ask for the seam again; the default next page would
        // start one row late and leave the hole this resync exists for. A
        // delete during the fetch may have set a nearer seam; keep that one.
        if (consumedSeam >= 0) {
          seamRef.current = seamRef.current >= 0
            ? Math.min(seamRef.current, consumedSeam)
            : consumedSeam;
        }
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
      if (reqId === requestIdRef.current) {
        setLoadingMore(false);
        // A delete landed while this page was in flight, so the page predates
        // it and the seam still needs a fetch of its own. Not while a retry is
        // queued or the budget is spent: both have their own way back.
        if (seamRef.current >= 0 && !blockedRef.current && !retryPendingRef.current) {
          scheduleBackfill();
        }
      }
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
      // A restore landing on a seeded row must wait for the fresh page 1: the
      // seed is what is on screen, not what the server answered. A failed page
      // 1 clears `loadingRef` when its budget is spent, so the restore settles
      // on the seed rather than polling to the deadline.
      revalidating: () => seededRef.current && loadingRef.current,
    };
  });
  useEffect(() => {
    if (!focusPrefix) return undefined;
    return registerFocusListing(focusPrefix, {
      loadMore: () => driverStateRef.current?.loadMore(),
      canLoad: () => !!driverStateRef.current?.canLoad,
      // Read through the ref: a restore that lands on the page-1 seed must
      // wait for the fresh page, or a re-ordered list drops the focused card.
      revalidating: () => !!driverStateRef.current?.revalidating?.(),
      pending: false,
    });
  }, [focusPrefix]);

  return {
    items, total, page, loading, retrying, loadingMore, error, exhausted, loadMore,
  };
}
