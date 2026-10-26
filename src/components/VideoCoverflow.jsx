/**
 * VideoCoverflow — 3D coverflow layout.
 *
 * Cards on a virtual rail: the centred card flat and forward, neighbours
 * rotated around Y with a floor reflection for depth. Follows focus via
 * `focusin` and recentres, like the carousel.
 *
 * Paging lives in usePagedList; this component supplies the request and the
 * trigger (the focused index nearing the end of the rail).
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import VideoCard from './VideoCard.jsx';
import ListingState from './ListingState.jsx';
import { fetchVideos } from '../utils/videoService.js';
import { getCurrentFocusId } from '../hooks/useFocusable.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './VideoCoverflow.module.css';

const PAGE_SIZE = 40;
const LOAD_MORE_THRESHOLD = 8;

const SLOT_W       = 460;   // base card width in px
const X_SPACING    = 320;   // horizontal distance between adjacent card centres
const SIDE_ROT     = 55;    // degrees neighbours rotate around Y
const SIDE_Z_BASE  = -200;  // base Z recede for first neighbour
const RENDER_RANGE = 5    // cards to render on each side of focus

export default function VideoCoverflow({ controls, objectFilter, searchQuery, onVideoSelect, onVideoLongPress }) {

  const { sort, order } = controls;

  const [focusedIndex, setFocusedIndex] = useState(0);

  // Named, not inline: the play queue is handed the same closure, so a queue
  // started here pages the rail's listing.
  const fetchPage = useCallback(
    (page) =>
      fetchVideos({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE })
        .then(d => ({ items: d.videos, total: d.total })),
    [sort, order, objectFilter, searchQuery],
  );

  // `items` is aliased to `videos` — that is what this view lists.
  const {
    items: videos, total, page, loading, loadingMore, error, loadMore,
  } = usePagedList({
    fetchPage,
    // A new request identity resets the list, and the focus along with it.
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
    // A restore by `video-<id>` must page forward past the first page — see
    // utils/focus.js.
    focusPrefix: 'video',
  });

  // Stable identity, as in the grid: focus restyles the slots, but the cards
  // inside can skip when their props hold still.
  const listing = useMemo(
    () => ({ items: videos, total, page, fetchPage }),
    [videos, total, page, fetchPage],
  );

  // Reset the focused slot when the list is replaced, or the rail would centre
  // an index that no longer exists.
  useEffect(() => { setFocusedIndex(0); }, [sort, order, objectFilter, searchQuery]);

  useEffect(() => {
    if (videos.length === 0) return;
    if (videos.length - focusedIndex <= LOAD_MORE_THRESHOLD) loadMore();
  }, [focusedIndex, videos.length, loadMore]);

  const [isFocusInGrid, setIsFocusInGrid] = useState(false);

  useEffect(() => {
    const onFocus = () => {
      const fid = getCurrentFocusId();
      const inGrid = !!fid && fid.startsWith('video-');
      setIsFocusInGrid(inGrid);
      if (!inGrid) return;
      const id = fid.slice('video-'.length);
      const idx = videos.findIndex(v => String(v.id) === String(id));
      if (idx >= 0 && idx !== focusedIndex) setFocusedIndex(idx);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [videos, focusedIndex]);
  

  if (loading) return (
    <ListingState
      id="state-videos"
      styles={styles}
      loading
      spinnerLabel="Loading videos"
      text="Loading videos…"
    />
  );

  if (error && !videos.length) return (
    <ListingState id="state-videos" styles={styles} error text={`Error: ${error}`} />
  );

  if (!videos.length) return (
    <ListingState id="state-videos" styles={styles} text="No videos found." />
  );

  const focused = videos[focusedIndex] || videos[0];

  return (
    <div className={styles.wrapper}>
      <div className={styles.hero}>
        <h2 className={styles.heroTitle}>{focused.title}</h2>
        <div className={styles.heroMeta}>
          {focused.year && <span>{focused.year}</span>}
          {focused.duration && <span>{focused.duration}</span>}
          {focused.category && <span className={styles.heroTag}>{focused.category}</span>}
          {focused.rating && <span className={styles.heroRating}>★ {focused.rating}</span>}
        </div>
        <div className={styles.heroCounter}>
          <span className={styles.heroCounterCur}>{focusedIndex + 1}</span>
          <span className={styles.heroCounterSep}>/</span>
          <span className={styles.heroCounterTotal}>{total || videos.length}</span>
        </div>
      </div>

      <div className={styles.stage}>
        <div className={styles.scene}>
          {videos.map((video, i) => {
            const offset = i - focusedIndex;
            const abs = Math.abs(offset);
            if (abs > RENDER_RANGE) return null;

            const sign = Math.sign(offset);
            // 0 at centre, ±SIDE_ROT for first neighbours, capped near 70°.
            const rotY = sign * Math.min(70, SIDE_ROT + Math.max(0, abs - 1) * 4);
            const z = abs === 0 ? 0 : SIDE_Z_BASE * (0.6 + abs * 0.4);
            const x = offset * X_SPACING;
            const cardScale = abs === 0 && isFocusInGrid ? 1.05 : 1;
            const opacity   = abs === 0 ? 1 : Math.max(0.4, 1 - abs * 0.15);

            // The slot's CSS anchors it at top:50%; this transform is applied
            // relative to that centre.
            const transform =
              abs === 0
                ? `translateY(-50%) translate3d(${x}px, 0, ${z}px) scale(${cardScale})`
                : `translateY(-50%) translate3d(${x}px, 0, ${z}px) rotateY(${-rotY}deg) scale(${cardScale})`;

            return (
              <div
                key={video.id}
                className={`${styles.slot} ${abs === 0 ? styles.slotFocused : ''}`}
                style={{
                  width: `${SLOT_W}px`,
                  transform,
                  opacity,
                  zIndex: 100 - abs,
                }}
                aria-hidden={abs !== 0}
              >
                <VideoCard
                  item={video}
                  index={i}
                  list={listing}
                  onSelect={onVideoSelect}
                  onLongPress={onVideoLongPress}
                />
                {/* Only the central few get a reflection; far cards are too
                    small on screen to benefit. */}
                {abs <= 2 && video.thumbnail && (
                  <div
                    className={styles.reflection}
                    style={{ backgroundImage: `url("${video.thumbnail}")` }}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className={styles.floor} aria-hidden="true" />
      </div>

      {loadingMore && (
        <div className={styles.loadingMore}>
          <div className={styles.spinnerSm} />
          <span>Loading more…</span>
        </div>
      )}

      {error && !loadingMore && videos.length > 0 && (
        <div className={styles.loadingMore} style={{ color: 'var(--red)' }}>
          <span>Couldn't load more — {error}</span>
        </div>
      )}
    </div>
  );
}