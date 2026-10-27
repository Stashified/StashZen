/**
 * PerformerGrid, infinite-scroll grid, reactive to controls.
 *
 * As in VideoGrid, usePagedList owns paging and this supplies the request and
 * the trigger.
 */

import { useEffect, useRef, useCallback } from 'react';
import PerformerCard from './PerformerCard.jsx';
import ListingState from './ListingState.jsx';
import ListStats from './ListStats.jsx';
import { fetchPerformers } from '../utils/performerService.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './PerformerGrid.module.css';

const PAGE_SIZE = 40;

export default function PerformerGrid({ controls, onPerformerSelect, objectFilter, searchQuery }) {
  const { sort, order, cols } = controls;

  const fetchPage = useCallback(
    (page, signal) =>
      fetchPerformers({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE, signal })
        .then(d => ({ items: d.performers, total: d.total })),
    [sort, order, objectFilter, searchQuery],
  );

  const {
    items: performers, total, loading, retrying, loadingMore, error, exhausted, loadMore,
  } = usePagedList({
    fetchPage,
    // sort and order MUST be in the key
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
    // Back from the detail page remounts at page 1; the restore pages forward
    // to the performer that was opened.
    focusPrefix: 'performer',
  });

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
      id="state-performers"
      styles={styles}
      loading
      spinnerLabel="Loading performers"
      text={retrying ? 'Connection problem, retrying…' : 'Loading performers…'}
    />
  );

  if (error && !performers.length) return (
    <ListingState id="state-performers" styles={styles} error text={`Error: ${error}`} />
  );

  if (!performers.length) return (
    <ListingState id="state-performers" styles={styles} text="No performers found." />
  );

  return (
    <div className={styles.page}>
      <ListStats loaded={performers.length} total={total} noun="performers" />
      <div className={styles.gridWrapper} ref={scrollRef}>
      <div
        className={styles.grid}
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
        role="grid"
        aria-label="Performer grid"
      >
        {performers.map((p, i) => (
          <PerformerCard key={p.id} item={p} index={i} onSelect={onPerformerSelect} />
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
          <span>{total} performers loaded</span>
        </div>
      )}
      </div>
    </div>
  );
}
