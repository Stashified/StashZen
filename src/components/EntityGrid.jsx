/**
 * EntityGrid — infinite-scroll grid for the four browse-only sections.
 *
 * As in the other grids, `usePagedList` owns the state machine while this
 * supplies the request and the trigger. service, itemsKey, card, noun and
 * aria-label all come from the `view` descriptor.
 *
 * Deliberately no long-press menu or fade overlays, unlike VideoGrid: those
 * belong to scenes and to cards that scrub on focus.
 */

import { useEffect, useRef, useCallback } from 'react';
import ListingState from './ListingState.jsx';
import ListStats from './ListStats.jsx';
import { usePagedList } from '../hooks/usePagedList.js';
import { useStableListing } from '../hooks/useStableListing.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './EntityGrid.module.css';

const PAGE_SIZE = 40;

export default function EntityGrid({
  controls, view, objectFilter, searchQuery, onSelect, onLongPress,
}) {
  const { sort, order, cols } = controls;
  const { Card, service, itemsKey, noun, gridLabel } = view;

  const fetchPage = useCallback(
    (page) =>
      service({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE })
        .then(d => ({ items: d[itemsKey], total: d.total })),
    [service, itemsKey, sort, order, objectFilter, searchQuery],
  );

  const {
    items, total, page, loading, loadingMore, error, exhausted, loadMore,
  } = usePagedList({
    fetchPage,
    // sort and order MUST be in the key
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
    // Back into a filtered listing lands on page 1; the restore in
    // utils/focus.js pages forward.
    focusPrefix: view.focusPrefix,
  });

  // No `fetchPage`: the Images viewer takes a snapshot and cannot page, and the
  // Carousel's shape otherwise applies. `useStableListing` so a page append
  // does not hand every card a new prop.
  const listing = useStableListing({ items, total, page });

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
      id={`state-${noun}`}
      styles={styles}
      loading
      spinnerLabel={`Loading ${noun}`}
      text={`Loading ${noun}…`}
    />
  );

  if (error && !items.length) return (
    <ListingState id={`state-${noun}`} styles={styles} error text={`Error: ${error}`} />
  );

  if (!items.length) return (
    <ListingState id={`state-${noun}`} styles={styles} text={`No ${noun} found.`} />
  );

  return (
    <div className={styles.page}>
      <ListStats loaded={items.length} total={total} noun={noun} />
      <div className={styles.gridWrapper} ref={scrollRef}>
        <div
          className={styles.grid}
          style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
          role="grid"
          aria-label={gridLabel}
        >
          {items.map((item, i) => (
            <Card
              key={item.id}
              item={item}
              index={i}
              list={listing}
              onSelect={onSelect}
              onLongPress={onLongPress}
              view={view}
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
            <span>{total.toLocaleString()} {noun} loaded</span>
          </div>
        )}
      </div>
    </div>
  );
}
