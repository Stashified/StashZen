/**
 * VideoCard, individual video thumbnail card in the grid.
 *
 * Cover screenshot plus an optional focus preview layered on top. Takes its
 * record as `item`, like every card, so one container can render any of them
 * (see Carousel).
 *
 * **The cover is never hidden.** `paths.preview` is a non-empty URL for every
 * scene whether or not the file was generated, so a preview-first design ends
 * black. The preview is a second layer at `opacity: 0`, revealed only on the
 * `<video>`'s own `playing` event, a decoded frame, not a load, a 200 or
 * `canplay`. If it never arrives, the cover is already there.
 *
 * The element is its own probe, the only honest one: a missing preview 404s,
 * and an unauthenticated request answers `302 → /login`, which a
 * redirect-following client sees as `200 text/html`. Neither is distinguishable
 * from success by status code, so `onError` plus a watchdog is the design.
 *
 * Cost control: only the focused card mounts a `<video>`, once the D-pad has
 * settled, and only after every cover on the page has loaded. A preview is
 * 1-3 MB against a cover's 10 KB; starting it first fills the listing row by
 * row.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { usePreviewSettings } from '../utils/settings.js';
import styles from './VideoCard.module.css';

// How long focus must rest on this card before the preview is mounted. Long
// enough that a held arrow never reaches it, short enough to feel immediate.
const PREVIEW_ARM_DELAY_MS = 400;
// No `playing` within this window → stop trying for this focus.
const PREVIEW_WATCHDOG_MS = 1200;
// A preview is 1-3 MB, a cover around 10 KB. Wait for every cover on the page
// before starting one, or the preview competes with the grid. Cards register
// their own cover while it is in flight; the set is module-level because what
// matters is the page, not this card.
const COVER_SETTLE_MS = 300;
// Safety valve: never hold a preview longer than this if a cover never reports.
const PREVIEW_COVER_WAIT_MS = 10000;
let lastCoverLoadAt = 0;
const pendingCovers = new Set();

function noteCoverLoad() { lastCoverLoadAt = Date.now(); }
function coversReady() {
  return pendingCovers.size === 0 && Date.now() - lastCoverLoadAt >= COVER_SETTLE_MS;
}

/**
 * Scenes whose preview errored, so they are never tried again, otherwise
 * every pass over the card re-requests a 404.
 *
 * Module-level, and partitioned by data source: the Map outlives the `dataKey`
 * remount that clears React state, so without the key a scene marked bad
 * against one server would stay bad after pointing the app at another.
 */
const badPreviews = new Map(); // dataSourceKey → Set(sceneId)

// Bounded because nothing ever removes an id: a long session would otherwise
// hold every preview that 404'd since launch. Sets iterate in insertion order,
// so the oldest entry is the one dropped, and a formerly-bad card is simply
// retried. The source cap covers the settings screen's URL field.
const BAD_PREVIEWS_MAX = 400;
const BAD_SOURCES_MAX = 8;

function isBad(source, id) {
  return !!badPreviews.get(source)?.has(id);
}

function markBad(source, id) {
  let set = badPreviews.get(source);
  if (!set) {
    set = new Set();
    badPreviews.set(source, set);
    while (badPreviews.size > BAD_SOURCES_MAX) {
      badPreviews.delete(badPreviews.keys().next().value);
    }
  }
  set.add(id);
  while (set.size > BAD_PREVIEWS_MAX) set.delete(set.values().next().value);
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
 * `list` is the listing this card belongs to, array, total, page and fetch
 * closure. Opaque here: the card hands it back up on select/long-press so a
 * queue opened here continues in the order the user was looking at. See
 * usePlayQueue.
 *
 * `onLongPress` is optional; its absence keeps every other card on instant
 * keydown, see the long-press note in useFocusable.
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
  // Only the preview settings, not the whole store: a card is memoised, but a
  // subscription to every setting re-rendered all forty of them on any write.
  const settings = usePreviewSettings();
  const source = settings.source;

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

  // All five must hold: previews enabled, motion not reduced (autoplay is the
  // motion this setting mainly exists for), not mock data (null previews,
  // external thumbnails), a URL to try, and no earlier failure.
  const canTry = settings.previewsEnabled
    && !settings.reduceMotion
    && !settings.useMock
    && !!item.preview
    && !isBad(source, item.id);

  const [armed, setArmed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);

  const armTimerRef = useRef(null);
  const previewRef = useRef(null);
  const imgRef = useRef(null);

  // The cover token identifies this card in `pendingCovers`. The done flag
  // covers an image that decoded before the effect below could register it.
  const coverTokenRef = useRef(null);
  if (coverTokenRef.current === null) coverTokenRef.current = {};
  const coverDoneRef = useRef(false);

  const coverDone = () => {
    coverDoneRef.current = true;
    pendingCovers.delete(coverTokenRef.current);
    noteCoverLoad();
  };

  useEffect(() => {
    if (coverDoneRef.current || imgError || !item.thumbnail) return undefined;
    // Already decoded before this effect ran: nothing to wait for.
    if (imgRef.current?.complete) {
      coverDoneRef.current = true;
      noteCoverLoad();
      return undefined;
    }
    pendingCovers.add(coverTokenRef.current);
    return () => pendingCovers.delete(coverTokenRef.current);
  }, [item.thumbnail, imgError]);

  useEffect(() => {
    clearTimeout(armTimerRef.current);
    setArmed(false);
    setPlaying(false);
    setGaveUp(false);
    if (!focused || !canTry) return;

    // Re-checked on a loop: a held arrow can stop at the grid edge, leaving
    // `is-navigating` set with focus unmoved.
    //
    // Covers get the pipe first: the preview waits until the page's covers
    // have loaded, so the grid fills as it does with previews off.
    const settle = (startedAt) => {
      if (document.body.classList.contains('is-navigating')) {
        armTimerRef.current = setTimeout(() => settle(startedAt), 200);
        return;
      }
      if (!coversReady() && Date.now() - startedAt < PREVIEW_COVER_WAIT_MS) {
        armTimerRef.current = setTimeout(() => settle(startedAt), 150);
        return;
      }
      setArmed(true);
    };
    armTimerRef.current = setTimeout(() => settle(Date.now()), PREVIEW_ARM_DELAY_MS);

    return () => clearTimeout(armTimerRef.current);
  }, [focused, canTry]);

  useEffect(() => {
    // `playing` is a dependency, not just a guard, so the timer clears the
    // moment a frame arrives. Otherwise the watchdog fires a second into a good
    // preview, sets `gaveUp` and unmounts the element.
    if (!armed || playing) return;
    const t = setTimeout(() => {
      // No frame in time: stop for this focus and let the cover stay. NOT
      // recorded in `badPreviews`, this window cannot tell slow from absent,
      // and a real 404 reports through `onError` below; blacklisting on a
      // timeout would make one slow response permanent.
      setGaveUp(true);
    }, PREVIEW_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [armed, playing]);

  // Set on the element, not passed as a prop: React applies `muted` after the
  // element is in the tree, autoplay has already begun, and the browser refuses
  // the unmuted video, so the preview silently never plays.
  useEffect(() => {
    const el = previewRef.current;
    if (el) el.muted = settings.previewMuted;
  }, [armed, gaveUp, canTry, settings.previewMuted]);

  const previewMounted = armed && !gaveUp && canTry;
  const res = resolutionLabel(item.height);
  // Only some rows carry these (related rows and the mock library do), so
  // every mark is optional.
  const oCount = Number(item.o_counter) || 0;

  return (
    <button
      ref={ref}
      className={`${styles.card} ${fill ? styles.fill : ''} ${focused ? styles.focused : ''}`}
      onClick={() => onSelect?.(item, list)}
      aria-label={`${item.title}${item.year ? `, ${item.year}` : ''}${item.rating ? `, rated ${item.rating}` : ''}`
        + `${item.play_count ? ', watched' : ''}${item.organized ? ', organised' : ''}`
        + `${oCount ? `, O count ${oCount}` : ''}`}
    >
      <div className={styles.thumb}>
        {!imgError && item.thumbnail ? (
          <img
            ref={imgRef}
            src={item.thumbnail}
            alt=""
            className={styles.img}
            onLoad={coverDone}
            onError={() => { coverDone(); setImgError(true); }}
            // Eager on purpose: the preview gate waits for this card, so a
            // lazy cover would hold the preview until it is scrolled to.
            loading="eager"
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
        {(item.play_count > 0 || item.organized || oCount > 0) && (
          <div className={styles.badges}>
            {item.play_count > 0 && (
              <span className={`${styles.badge} ${styles.watched}`} aria-hidden="true">▶</span>
            )}
            {item.organized && (
              <span className={`${styles.badge} ${styles.organized}`} aria-hidden="true">✓</span>
            )}
            {oCount > 0 && (
              <span className={`${styles.badge} ${styles.oCount}`} aria-hidden="true">O {oCount}</span>
            )}
          </div>
        )}
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
