/**
 * VideoCoverflow, 3D coverflow layout.
 *
 * Cards on a virtual rail: the centred card flat and forward, neighbours
 * rotated around Y with a floor reflection for depth. Follows focus via
 * `focusin` and recentres, like the carousel.
 *
 * Paging lives in usePagedList; this component supplies the request and the
 * trigger (the focused index nearing the end of the rail). The hero comes from
 * SCENE_VIEW, so the two scene views cannot drift.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import VideoCard from './VideoCard.jsx';
import { SCENE_VIEW } from './carouselViews.js';
import ListingState from './ListingState.jsx';
import { fetchVideos } from '../utils/videoService.js';
import { getCurrentFocusId } from '../hooks/useFocusable.js';
import { onFocusRestoreRequest } from '../utils/focus.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { pageRequestKey } from '../utils/requestKey.js';
import HeroInfo from './HeroInfo.jsx';
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
  // One identity for the list and the focus reset, so a filter object rebuilt
  // with the same contents cannot reset the focused slot.
  const requestKey = pageRequestKey(sort, order, objectFilter, searchQuery);

  const [focusedIndex, setFocusedIndex] = useState(0);

  // Named, not inline: the play queue is handed the same closure, so a queue
  // started here pages the rail's listing.
  const fetchPage = useCallback(
    (page, signal) =>
      fetchVideos({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE, signal })
        .then(d => ({ items: d.videos, total: d.total })),
    [sort, order, objectFilter, searchQuery],
  );

  // `items` is aliased to `videos`, that is what this view lists.
  const {
    items: videos, total, page, loading, retrying, loadingMore, error, loadMore,
  } = usePagedList({
    fetchPage,
    // A new request identity resets the list, and the focus along with it.
    requestKey,
    // A restore by `video-<id>` must page forward past the first page, see
    // utils/focus.js.
    focusPrefix: 'video',
    entity: 'scene',
  });

  // Stable identity, as in the grid: focus restyles the slots, but the cards
  // inside can skip when their props hold still.
  const listing = useMemo(
    () => ({ items: videos, total, page, fetchPage }),
    [videos, total, page, fetchPage],
  );

  // Reset the focused slot when the list is replaced, or the rail would centre
  // an index that no longer exists.
  useEffect(() => { setFocusedIndex(0); }, [requestKey]);

  useEffect(() => {
    if (videos.length === 0) return;
    if (videos.length - focusedIndex <= LOAD_MORE_THRESHOLD) loadMore();
  }, [focusedIndex, videos.length, loadMore]);

  // Same shrink guard as Carousel: the state must leave the removed slot, not
  // just the render, or the load-more arithmetic goes negative.
  useEffect(() => {
    if (videos.length && focusedIndex > videos.length - 1) {
      setFocusedIndex(videos.length - 1);
    }
  }, [focusedIndex, videos.length]);

  const [isFocusInGrid, setIsFocusInGrid] = useState(false);

  // The listener reads the list and the current slot at event time. Depending
  // on them would tear it down and re-add it on every focus change and page.
  const videosRef = useRef(videos);
  videosRef.current = videos;
  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;

  useEffect(() => {
    const onFocus = () => {
      const fid = getCurrentFocusId();
      const inGrid = !!fid && fid.startsWith('video-');
      setIsFocusInGrid(inGrid);
      if (!inGrid) return;
      const id = fid.slice('video-'.length);
      const idx = videosRef.current.findIndex(v => String(v.id) === String(id));
      if (idx >= 0 && idx !== focusedIndexRef.current) setFocusedIndex(idx);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);

  // Only ±RENDER_RANGE slots are mounted, so a restore naming a card outside
  // that window has no element to reach. Move the window to it, now or when
  // the row pages in.
  const pendingRestoreRef = useRef(null);
  const moveToRestore = useCallback((fid) => {
    const id = fid.slice('video-'.length);
    const idx = videos.findIndex(v => String(v.id) === String(id));
    if (idx < 0) return false;
    setFocusedIndex(idx);
    return true;
  }, [videos]);

  useEffect(() => onFocusRestoreRequest((fid) => {
    if (!fid) { pendingRestoreRef.current = null; return; }
    if (!fid.startsWith('video-')) return;
    pendingRestoreRef.current = moveToRestore(fid) ? null : fid;
  }), [moveToRestore]);

  useEffect(() => {
    if (pendingRestoreRef.current && moveToRestore(pendingRestoreRef.current)) {
      pendingRestoreRef.current = null;
    }
  }, [moveToRestore]);


  if (loading && !videos.length) return (
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

  // A replaced list can leave the index past the end for a frame; clamp it so
  // the counter and the window never point outside the rail.
  const index = Math.min(focusedIndex, videos.length - 1);
  const focused = videos[index] || videos[0];
  const { title, meta = [], details } = SCENE_VIEW.hero(focused);
  // The window's first index; also the offset for the absolute index of a
  // sliced entry.
  const windowStart = Math.max(0, index - RENDER_RANGE);

  return (
    <div className={styles.wrapper}>
      <HeroInfo
        title={title}
        meta={meta}
        details={details}
        index={index}
        total={total || videos.length}
        variant="coverflow"
      />

      <div className={styles.stage}>
        <div className={styles.scene}>
          {/* Slice before mapping: the rail accumulates pages, and mapping all
              of it just to return null past the window is work per frame. */}
          {videos.slice(windowStart, index + RENDER_RANGE + 1).map((video, n) => {
            const i = windowStart + n;
            const offset = i - index;
            const abs = Math.abs(offset);

            const sign = Math.sign(offset);
            // 0 at centre, ±SIDE_ROT for first neighbours, capped near 70°.
            const rotY = sign * Math.min(70, SIDE_ROT + Math.max(0, abs - 1) * 4);
            const z = abs === 0 ? 0 : SIDE_Z_BASE * (0.6 + abs * 0.4);
            const x = offset * X_SPACING;
            const cardScale = abs === 0 && isFocusInGrid ? 1.05 : 1;
            const opacity   = abs === 0 ? 1 : Math.max(0.4, 1 - abs * 0.15);

            // The slot's CSS anchors it at top:50%; this transform is applied
            // relative to that centre.
            //
            // The centred card stays 2D and its perspective sits on the rotated
            // neighbours instead of `.scene`: Tizen draws a <video> inside a
            // 3D-transformed layer as a black plane, and the centred card is
            // the only one that previews. See the note in the CSS.
            const transform =
              abs === 0
                ? `translateY(-50%) translate(${x}px, 0) scale(${cardScale})`
                : `translateY(-50%) perspective(1400px) translate3d(${x}px, 0, ${z}px) rotateY(${-rotY}deg) scale(${cardScale})`;

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
                {/* Only the centred card gets a reflection: it is the one whose
                    underside is actually in view, and each reflection is a
                    full-cover image with a mask of its own. */}
                {abs === 0 && video.thumbnail && (
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
          <span>Couldn't load more: {error}</span>
        </div>
      )}
    </div>
  );
}