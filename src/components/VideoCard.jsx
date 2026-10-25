/**
 * VideoCard — individual video thumbnail card in the grid.
 *
 * Cover screenshot plus an optional focus preview layered on top. Takes its
 * record as `item`, like every card, so one container can render any of them
 * (see Carousel).
 *
 * **The cover is never hidden.** `paths.preview` is a non-empty URL for every
 * scene whether or not the file was generated, so a preview-first design ends
 * black. The preview is a second layer at `opacity: 0`, revealed only on the
 * `<video>`'s own `playing` event — a decoded frame, not a load, a 200 or
 * `canplay`. If it never arrives, the cover is already there.
 *
 * The element is its own probe, the only honest one: a missing preview 404s,
 * and an unauthenticated request answers `302 → /login`, which a
 * redirect-following client sees as `200 text/html`. Neither is distinguishable
 * from success by status code, so `onError` plus a watchdog is the design.
 *
 * Cost control: only the focused card mounts a `<video>`, and only once the
 * D-pad has settled — a held arrow crosses several cards a second. The signal
 * is the `is-navigating` body class.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useSettings, dataSourceKey } from '../utils/settings.js';
import styles from './VideoCard.module.css';

// How long focus must rest on this card before the preview is mounted. Long
// enough that a held arrow never reaches it, short enough to feel immediate.
const PREVIEW_ARM_DELAY_MS = 400;
// No `playing` within this window → stop trying for this focus.
const PREVIEW_WATCHDOG_MS = 1200;

/**
 * Scenes whose preview errored, so they are never tried again — otherwise
 * every pass over the card re-requests a 404.
 *
 * Module-level, and partitioned by data source: the Map outlives the `dataKey`
 * remount that clears React state, so without the key a scene marked bad
 * against one server would stay bad after pointing the app at another.
 */
const badPreviews = new Map(); // dataSourceKey → Set(sceneId)

function isBad(source, id) {
  return !!badPreviews.get(source)?.has(id);
}

function markBad(source, id) {
  let set = badPreviews.get(source);
  if (!set) { set = new Set(); badPreviews.set(source, set); }
  set.add(id);
}

/**
 * The resolution half of the bottom-right badge, from `file.height`.
 *
 * Buckets are coarse on purpose: at ten feet "1080P" vs "720P" is the
 * distinction anyone can make, and exact height belongs on the detail page.
 * 2160 gets a name because nobody calls it "2160P".
 */
function resolutionLabel(height) {
  if (!height) return null;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440P';
  if (height >= 1080) return '1080P';
  if (height >= 720) return '720P';
  if (height >= 480) return '480P';
  return `${height}P`;
}

/**
 * `list` is the listing this card belongs to — array, total, page and fetch
 * closure. Opaque here: the card hands it back up on select/long-press so a
 * queue opened here continues in the order the user was looking at. See
 * usePlayQueue.
 *
 * `onLongPress` is optional; its absence keeps every other card on instant
 * keydown — see the long-press note in useFocusable.
 */
function VideoCard({
  item, index, list, onSelect, onLongPress,
  // The showroom gives its scene shelf its own focus-id namespace, distinct
  // from the numbered `video-` ids and the other shelf families (`studio-`,
  // `performer-`, `gallery-`). The registry is a keyed Map, so a duplicate id
  // would let one card overwrite the other.
  focusIdPrefix = 'video',
  // Only the top shelf's first card may claim focus on mount; the showroom
  // passes `false` elsewhere rather than letting four shelves race for it.
  autoFocus = index === 0,
  // Optional explicit edge per direction, as the rail's rows use. The top shelf
  // passes `{ up: 'nav-home' }`: with no controls bar on Home the geometry sends
  // Up to whichever rail row is nearest the shelf's centre (Scenes, not the
  // active one). Up mirrors Left's "return to the tab you are on".
  nextId = null,
  // Home fixes every shelf card's height. `fill` lets the thumbnail take
  // whatever the info bar leaves instead of holding 16:9, so the scene shelf
  // matches the three overlay card families. Listings keep their aspect ratio.
  fill = false,
}) {
  const [imgError, setImgError] = useState(false);
  const settings = useSettings();
  const source = dataSourceKey(settings);

  const { ref, focused } = useFocusable({
    id: `${focusIdPrefix}-${item.id}`,
    group: 'grid',
    onEnter: () => onSelect?.(item, list),
    onLongPress: onLongPress ? () => onLongPress(item, list, index) : undefined,
    autoFocus,
    // A listing reset must not steal focus from Search or the controls bar.
    autoFocusWhenIdle: true,
    nextId,
  });

  // All four must hold: previews enabled, not mock data (null previews,
  // external thumbnails), a URL to try, and no earlier failure.
  const canTry = settings.previewsEnabled
    && !settings.useMock
    && !!item.preview
    && !isBad(source, item.id);

  const [armed, setArmed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);

  const armTimerRef = useRef(null);
  const previewRef = useRef(null);

  useEffect(() => {
    clearTimeout(armTimerRef.current);
    setArmed(false);
    setPlaying(false);
    setGaveUp(false);
    if (!focused || !canTry) return;

    // Re-checked on a loop, not once: a *held* arrow can stop at the edge of
    // the grid, so focus never moves again and `is-navigating` may still be set
    // when a single check would run. It would never arm, and the card under the
    // cursor would have no preview for no visible reason.
    const settle = () => {
      if (document.body.classList.contains('is-navigating')) {
        armTimerRef.current = setTimeout(settle, 200);
        return;
      }
      setArmed(true);
    };
    armTimerRef.current = setTimeout(settle, PREVIEW_ARM_DELAY_MS);

    return () => clearTimeout(armTimerRef.current);
  }, [focused, canTry]);

  useEffect(() => {
    // `playing` is a dependency, not just a guard, so the timer clears the
    // moment a frame arrives. Otherwise the watchdog fires a second into a good
    // preview, sets `gaveUp` and unmounts the element.
    if (!armed || playing) return;
    const t = setTimeout(() => {
      // No frame in time: stop for this focus and let the cover stay. NOT
      // recorded in `badPreviews` — this window cannot tell slow from absent,
      // and a real 404 reports through `onError` below; blacklisting on a
      // timeout would make one slow response permanent.
      setGaveUp(true);
    }, PREVIEW_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [armed, playing]);

  // Set on the element, not passed as a prop: React applies `muted` after the
  // element is in the tree, autoplay has already begun, and the browser refuses
  // the unmuted video — so the preview silently never plays.
  useEffect(() => {
    const el = previewRef.current;
    if (el) el.muted = settings.previewMuted;
  }, [armed, gaveUp, canTry, settings.previewMuted]);

  const previewMounted = armed && !gaveUp && canTry;
  const res = resolutionLabel(item.height);

  return (
    <button
      ref={ref}
      className={`${styles.card} ${fill ? styles.fill : ''} ${focused ? styles.focused : ''}`}
      onClick={() => onSelect?.(item, list)}
      aria-label={`${item.title}${item.year ? `, ${item.year}` : ''}${item.rating ? `, rated ${item.rating}` : ''}`}
    >
      <div className={styles.thumb}>
        {!imgError && item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt=""
            className={styles.img}
            onError={() => setImgError(true)}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className={styles.imgFallback}>
            <span>{item.title?.[0] || '?'}</span>
          </div>
        )}

        {previewMounted && (
          <video
            ref={previewRef}
            src={item.preview}
            className={`${styles.preview} ${playing ? styles.previewVisible : ''}`}
            autoPlay
            loop
            playsInline
            preload="none"
            aria-hidden="true"
            onPlaying={() => setPlaying(true)}
            onError={() => {
              markBad(source, item.id);
              setGaveUp(true);
            }}
          />
        )}

        <div className={styles.overlay}>
          <div className={styles.playIcon}>▶</div>
        </div>

        {(res || item.duration) && (
          <div className={styles.duration}>{[res, item.duration].filter(Boolean).join(' ')}</div>
        )}
        {item.rating && <div className={styles.rating}>★ {item.rating}</div>}
      </div>
      {item.resume_time > 10 && item.durationSeconds > 0 && (
        <div className={styles.resumeBar} aria-hidden="true">
          <div
            className={styles.resumeFill}
            style={{ width: `${Math.min(100, (item.resume_time / item.durationSeconds) * 100)}%` }}
          />
        </div>
      )}

      <div className={styles.info}>
        <p className={styles.title}>{item.title}</p>
        <div className={styles.meta}>
          {item.year && <span className={styles.year}>{item.year}</span>}
          {item.category && <span className={styles.category}>{item.category}</span>}
        </div>
      </div>
    </button>
  );
}

// Cards are the bulk of a listing. Without memo, every append and every
// `loadingMore`/error toggle re-rendered all of them (the parent builds a fresh
// `list`). The grid and carousel pass a stable listing (`useStableListing`)
// whose getters read the latest rows, plus stable callbacks, so an append
// renders only the new cards. A `useMemo` keyed on `items` would not do: the
// append is what replaces `items`. Focus and settings subscriptions still
// re-render a card on their own, as they must.
export default memo(VideoCard);
