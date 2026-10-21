/**
 * MarkerGrid — Infinite-scroll grid of marker cards
 * Reads sort/order/cols from `controls` prop.
 *
 * The paging itself lives in usePagedList; this component supplies the
 * request and the trigger (a sentinel observed from inside the scroll
 * container). Same division of labour as VideoGrid.
 */

import { useEffect, useRef, useCallback } from 'react';
import MarkerCard from './MarkerCard.jsx';
import ListStats from './ListStats.jsx';
import { fetchMarkers } from '../utils/markerService.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { useStableListing } from '../hooks/useStableListing.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './VideoGrid.module.css'; // reuse VideoGrid styles for grid layout

const PAGE_SIZE = 40;

export default function MarkerGrid({
  controls, onMarkerSelect, onMarkerLongPress, objectFilter, searchQuery,
}) {
  const { sort, order, cols } = controls;

  const fetchPage = useCallback(
    (page) =>
      fetchMarkers({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE })
        .then(d => ({ items: d.markers, total: d.total })),
    [sort, order, objectFilter, searchQuery],
  );

  const {
    items: markers, total, page, loading, loadingMore, error, exhausted, loadMore,
  } = usePagedList({
    fetchPage,
    // ← critical: sort and order MUST be in the key
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
    // Closing the player returns to the marker card of the scene last viewed,
    // and a queue keeps playing through markers this grid has not loaded. The
    // restore asks the listing for the missing pages — see utils/focus.js.
    focusPrefix: 'marker',
  });

  // The listing travels to every card so the long-press menu can offer "Play
  // all" and "Play from here"; the queue reads `fetchPage` from here to
  // continue past the loaded markers. Same shape Carousel hands down —
  // `useStableListing`, so the prop's identity survives a page append (the
  // review's R6).
  const listing = useStableListing({ items: markers, total, page, fetchPage });

  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { root, rootMargin: '400px 0px', threshold: 0 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  if (loading) return (
    <div className={styles.state}>
      <div className={styles.spinner} />
      <p className={styles.stateText}>Loading markers…</p>
    </div>
  );

  if (error && !markers.length) return (
    <div className={styles.state}>
      <p className={styles.stateText} style={{ color: 'var(--red)' }}>Error: {error}</p>
    </div>
  );

  if (!markers.length) return (
    <div className={styles.state}>
      <p className={styles.stateText}>No markers found.</p>
    </div>
  );

  return (
    <div className={styles.page}>
      <ListStats loaded={markers.length} total={total} noun="markers" />
      <div className={styles.gridWrapper} ref={scrollRef}>
      <div
        className={styles.grid}
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
        role="grid"
        aria-label="Marker grid"
      >
        {markers.map((m, i) => (
          <MarkerCard
            key={m.id}
            item={m}
            index={i}
            list={listing}
            onSelect={onMarkerSelect}
            onLongPress={onMarkerLongPress}
          />
        ))}
      </div>

      {!exhausted && (
        <div ref={sentinelRef} className={styles.sentinel}>
          {loadingMore && (
            <>
              <div className={styles.spinnerSm} />
              <span className={styles.loadingMoreText}>Loading more…</span>
            </>
          )}
          {error && !loadingMore && (
            <span className={styles.loadingMoreText} style={{ color: 'var(--red)' }}>
              Couldn't load more — {error}
            </span>
          )}
        </div>
      )}

      {exhausted && (
        <div className={styles.endMarker}>
          <span>{total} markers loaded</span>
        </div>
      )}
      </div>
    </div>
  );
}
