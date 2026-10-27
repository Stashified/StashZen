/**
 * VideoGrid, NxM grid of VideoCard with infinite scroll.
 *
 * A change to `controls.sort` or `controls.order` resets and refetches from
 * page 1. Paging lives in usePagedList; this supplies the request and the
 * trigger (a sentinel observed inside the scroll container).
 */

import { useCallback, useEffect, useRef } from 'react';
import { useStableListing } from '../hooks/useStableListing.js';
import VideoCard from './VideoCard.jsx';
import ListingState from './ListingState.jsx';
import ListStats from './ListStats.jsx';
import { fetchVideos } from '../utils/videoService.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './VideoGrid.module.css';

const PAGE_SIZE = 40;

export default function VideoGrid({ controls, objectFilter, searchQuery, onVideoSelect, onVideoLongPress }) {
  const { sort, order, cols } = controls;

  // Named, not inline: the play queue shares this closure, so a queue started
  // here pages exactly the listing the grid shows.
  const fetchPage = useCallback(
    (page, signal) =>
      fetchVideos({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE, signal })
        .then(d => ({ items: d.videos, total: d.total })),
    [sort, order, objectFilter, searchQuery],
  );

  // `items` is aliased to `videos`, that is what this view lists.
  const {
    items: videos, total, page, loading, retrying, loadingMore, error, exhausted, loadMore,
  } = usePagedList({
    fetchPage,
    // sort and order MUST be in the key
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
    // A restore by `video-<id>` pages forward past the loaded page, see
    // utils/focus.js.
    focusPrefix: 'video',
    entity: 'scene',
  });

  // Stable identity with live getters, so a page append renders only the new
  // cards. See useStableListing.
  const listing = useStableListing({ items: videos, total, page, fetchPage });

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
      id="state-videos"
      styles={styles}
      loading
      spinnerLabel="Loading videos"
      text={retrying ? 'Connection problem, retrying…' : 'Loading videos…'}
    />
  );

  if (error && !videos.length) return (
    <ListingState id="state-videos" styles={styles} error text={`Error: ${error}`} />
  );

  if (!videos.length) return (
    <ListingState id="state-videos" styles={styles} text="No videos found." />
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
              Couldn't load more: {error}
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
