/**
 * EntityGrid — Infinite-scroll grid for the four browse-only sections.
 *
 * Same division of labour as the other three grids: `usePagedList` owns the
 * state machine, this component supplies the request and the trigger (a
 * sentinel observed from inside the scroll container). PerformerGrid differed
 * from VideoGrid and MarkerGrid in exactly five fields — service, itemsKey,
 * card, noun and aria-label — and all five now come from the `view` descriptor.
 *
 * What it deliberately does NOT have, compared with VideoGrid: the long-press
 * action menu, and the top/bottom fade overlays. Those belong to scenes (the
 * menu is Play/Play all/Details) and to a grid whose cards scrub on focus.
 */

import { useEffect, useRef, useCallback } from 'react';
import ListStats from './ListStats.jsx';
import { usePagedList } from '../hooks/usePagedList.js';
import styles from './EntityGrid.module.css';

const PAGE_SIZE = 40;

export default function EntityGrid({ controls, view, objectFilter, searchQuery, onSelect }) {
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
    // ← critical: sort and order MUST be here
    deps: [sort, order, objectFilter, searchQuery],
  });

  // Handed to each card, because the Images section's selection opens a viewer
  // that steps through the listing it was opened from. Same shape the Carousel
  // passes, minus `fetchPage`: the viewer takes a snapshot and does not page, so
  // offering it a way to extend the list would be offering something it cannot
  // honour. See ImageViewer's header.
  const listing = { items, total, page };

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
      <p className={styles.stateText}>Loading {noun}…</p>
    </div>
  );

  if (error && !items.length) return (
    <div className={styles.state}>
      <p className={styles.stateText} style={{ color: 'var(--red)' }}>Error: {error}</p>
    </div>
  );

  if (!items.length) return (
    <div className={styles.state}>
      <p className={styles.stateText}>No {noun} found.</p>
    </div>
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
            <Card key={item.id} item={item} index={i} list={listing} onSelect={onSelect} view={view} />
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
