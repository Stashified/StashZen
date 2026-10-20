/**
 * VideoGrid — NxM grid of VideoCard with infinite scroll
 *
 * Watches `controls.sort`, `controls.order` —
 * any change resets the grid and refetches from page 1.
 *
 * The paging itself lives in usePagedList; this component supplies the
 * request and the trigger (a sentinel observed from inside the scroll
 * container).
 */

import { useCallback, useEffect, useRef } from 'react';
import { useStableListing } from '../hooks/useStableListing.js';
import VideoCard from './VideoCard.jsx';
import ListStats from './ListStats.jsx';
import { fetchVideos } from '../utils/videoService.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './VideoGrid.module.css';

const PAGE_SIZE = 40;

export default function VideoGrid({ controls, objectFilter, searchQuery, onVideoSelect, onVideoLongPress }) {
  const { sort, order, cols } = controls;

  // Named, not inline: the same closure is handed to the play queue so that
  // a queue started from this grid pages exactly the listing the grid is
  // showing — same request, same listCache entries.
  const fetchPage = useCallback(
    (page) =>
      fetchVideos({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE })
        .then(d => ({ items: d.videos, total: d.total })),
    [sort, order, objectFilter, searchQuery],
  );

  // `items` is aliased to `videos` — that is what this view lists.
  const {
    items: videos, total, page, loading, loadingMore, error, exhausted, loadMore,
  } = usePagedList({
    fetchPage,
    // ← critical: sort and order MUST be in the key
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
    // Closing the player returns focus to the scene last viewed, which a
    // "Play all" queue can have walked past this grid's loaded page. The
    // restore pages the grid forward to find that card — see utils/focus.js.
    focusPrefix: 'video',
  });

  // Stable identity *and* current values: the getters read the latest rows
  // from the card's handler, so a page append can render only the new cards
  // instead of re-rendering every existing one. See useStableListing.
  const listing = useStableListing({ items: videos, total, page, fetchPage });

  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);

  // ── IntersectionObserver ─────────────────────────────────
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

  // ── Render ───────────────────────────────────────────────
  if (loading) return (
    <div className={styles.state}>
      <div className={styles.spinner} aria-label="Loading videos" />
      <p className={styles.stateText}>Loading videos…</p>
    </div>
  );

  if (error && !videos.length) return (
    <div className={styles.state}>
      <p className={styles.stateText} style={{ color: 'var(--red)' }}>Error: {error}</p>
    </div>
  );

  if (!videos.length) return (
    <div className={styles.state}>
      <p className={styles.stateText}>No videos found.</p>
    </div>
  );

  return (
    <div className={styles.page}>
      <ListStats loaded={videos.length} total={total} />
      <div className={styles.gridWrapper} ref={scrollRef}>
      <div
        className={styles.grid}
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
        role="grid"
        aria-label={`Video grid, ${cols} columns`}
      >
        {videos.map((video, i) => (
          <VideoCard
            key={video.id}
            item={video}
            index={i}
            list={listing}
            onSelect={onVideoSelect}
            onLongPress={onVideoLongPress}
          />
        ))}
      </div>

      {/* Unmounted once every row is loaded, so the observer has nothing
          left to intersect and `loadMore` is never asked for page N+1. */}
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
          <span>{total} videos loaded</span>
        </div>
      )}
      </div>
    </div>
  );
}
