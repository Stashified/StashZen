/**
 * VideoCoverflow — 3D coverflow layout
 *
 * Cards arranged on a virtual rail. Center card sits flat and forward;
 * neighbours rotate around the Y axis toward the camera. A floor
 * reflection sells the depth. Same focus-tracking pattern as the
 * carousel — listens to focusin and recenters on the focused index.
 *
 * Reuses VideoCard. Reads sort/order from `controls`.
 *
 * The paging itself lives in usePagedList; this component supplies the
 * request and the trigger (the focused index nearing the end of the rail).
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import VideoCard from './VideoCard.jsx';
import { fetchVideos } from '../utils/videoService.js';
import { getCurrentFocusId } from '../hooks/useFocusable.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './VideoCoverflow.module.css';

const PAGE_SIZE = 40;
const LOAD_MORE_THRESHOLD = 8;

// Layout constants — tweak to taste
const SLOT_W       = 460;   // base card width in px
const X_SPACING    = 320;   // horizontal distance between adjacent card centres
const SIDE_ROT     = 55;    // degrees neighbours rotate around Y
const SIDE_Z_BASE  = -200;  // base Z recede for first neighbour
const RENDER_RANGE = 5    // cards to render on each side of focus

export default function VideoCoverflow({ controls, objectFilter, searchQuery, onVideoSelect, onVideoLongPress }) {

  const { sort, order } = controls;

  const [focusedIndex, setFocusedIndex] = useState(0);

  // Named, not inline: the play queue is handed the same closure, so a
  // queue started here pages the listing the rail is showing.
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
    // The scene id a Back or a player-close restores (`video-<id>`) lives in
    // this view too. Without the registration the restore could only find a
    // card on the first page; with it, the listing pages forward — see
    // utils/focus.js.
    focusPrefix: 'video',
  });

  // Same memoized identity as the grid: focus moves restyle the slot wrappers,
  // but the cards inside them can skip the render when their props hold still.
  const listing = useMemo(
    () => ({ items: videos, total, page, fetchPage }),
    [videos, total, page, fetchPage],
  );

  // Reset the focused slot when the list underneath is replaced — otherwise
  // the rail would try to centre an index that no longer exists.
  useEffect(() => { setFocusedIndex(0); }, [sort, order, objectFilter, searchQuery]);

  // ── Fetch more when focus approaches the end ──────────────
  useEffect(() => {
    if (videos.length === 0) return;
    if (videos.length - focusedIndex <= LOAD_MORE_THRESHOLD) loadMore();
  }, [focusedIndex, videos.length, loadMore]);

  const [isFocusInGrid, setIsFocusInGrid] = useState(false);

  // ── Track which card is focused ───────────────────────────
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
  

  // ── Render ────────────────────────────────────────────────
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

  const focused = videos[focusedIndex] || videos[0];

  return (
    <div className={styles.wrapper}>
      {/* Hero info above the stage */}
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
            // Rotation: 0 at center, ±SIDE_ROT for first neighbours,
            // increasing slightly further out (capped near 70°).
            const rotY = sign * Math.min(70, SIDE_ROT + Math.max(0, abs - 1) * 4);
            // Z depth: focused card is closest, neighbours recede.
            const z = abs === 0 ? 0 : SIDE_Z_BASE * (0.6 + abs * 0.4);
            const x = offset * X_SPACING;
            const cardScale = abs === 0 && isFocusInGrid ? 1.05 : 1;
            const opacity   = abs === 0 ? 1 : Math.max(0.4, 1 - abs * 0.15);

            // The slot is anchored at top:50% with translateY(-50%) in
            // CSS (vertical centring). The inline transform handles
            // X position, Z depth, Y rotation, and uniform scale —
            // all relative to the slot's centred anchor.
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
                {/* Reflection — flipped clone of the thumbnail fades
                    into the floor. Only the central few cards get one;
                    far-side cards aren't large enough on screen to
                    benefit. */}
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

        {/* Floor gradient */}
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