/**
 * MarkerGrid, infinite-scroll grid of marker cards, reading sort/order/cols
 * from `controls`.
 *
 * As in VideoGrid, usePagedList owns paging and this supplies the request and
 * the trigger.
 */

import { useEffect, useRef, useCallback } from 'react';
import MarkerCard from './MarkerCard.jsx';
import ListingState from './ListingState.jsx';
import ListStats from './ListStats.jsx';
import { fetchMarkers } from '../utils/markerService.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { useStableListing } from '../hooks/useStableListing.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './VideoGrid.module.css'; // grid layout is shared

const PAGE_SIZE = 40;

export default function MarkerGrid({
  controls, onMarkerSelect, onMarkerLongPress, objectFilter, searchQuery,
}) {
  const { sort, order, cols } = controls;

  const fetchPage = useCallback(
    (page, signal) =>
      fetchMarkers({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE, signal })
        .then(d => ({ items: d.markers, total: d.total })),
    [sort, order, objectFilter, searchQuery],
  );

  const {
    items: markers, total, page, loading, retrying, loadingMore, error, exhausted, loadMore,
  } = usePagedList({
    fetchPage,
    // sort and order MUST be in the key
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
    // A restore by `marker-<id>` pages forward through unloaded markers, see
    // utils/focus.js.
    focusPrefix: 'marker',
  });

  // The listing travels to every card so the menu can offer "Play all" and
  // "Play from here", and the queue reads its `fetchPage`. `useStableListing`
  // keeps the identity across page appends.
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
    <ListingState
      id="state-markers"
      styles={styles}
      loading
      spinnerLabel="Loading markers"
      text={retrying ? 'Connection problem, retrying…' : 'Loading markers…'}
    />
  );

  if (error && !markers.length) return (
    <ListingState id="state-markers" styles={styles} error text={`Error: ${error}`} />
  );

  if (!markers.length) return (
    <ListingState id="state-markers" styles={styles} text="No markers found." />
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
              Couldn't load more: {error}
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
