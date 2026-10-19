/**
 * VideoCard — Individual video thumbnail card in the grid
 *
 * Cover screenshot, plus an optional focus preview layered on top of it.
 *
 * Takes its record as `item`, like every other card in the tree — the shared
 * name is what lets one container render any of them (`Carousel` does; see its
 * header). The scene-specific field names are unchanged.
 *
 * This card has had a preview before and lost it, so the reason is worth
 * keeping. v0.2.x faded the cover *out* and mounted a `<video>` pointing at
 * `paths.preview` 800 ms after focus. It was removed in 0.2.4. `paths.preview` is a non-empty
 * URL for *every* scene whether or not the file was ever generated, so the card
 * always took the preview branch; the video never painted a frame and the cover
 * was already gone, so the card sat on `.thumb`'s near-black background until
 * focus moved. That was the "thumbnail goes black if you linger on it" report.
 *
 * The rule this version is built on follows from it: **the cover is never
 * hidden.** The preview is a second layer that begins at `opacity: 0` and only
 * becomes visible on the `<video>`'s own `playing` event — a decoded frame, not
 * a load, not a 200, not `canplay`. If that never arrives, the cover is already
 * on screen and nothing has to be undone.
 *
 * The element is therefore its own probe, which is the only honest way to ask
 * here. The server cannot answer it: a scene with no preview 404s, and
 * (measured 2026-10-15) an *unauthenticated* request answers `302 → /login`,
 * which a client that follows redirects sees as `200 text/html`. Neither is
 * distinguishable from success by status code, so `onError` plus a watchdog is
 * the design rather than a fallback for one.
 *
 * Cost control: only the focused card ever mounts a `<video>`, and only once
 * the D-pad has settled on it — a held arrow crosses several cards a second and
 * every card it passed over would otherwise start a fetch. The signal for that
 * is the `is-navigating` body class the rest of the app already uses.
 */

import { useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useSettings, dataSourceKey } from '../utils/settings.js';
import styles from './VideoCard.module.css';

// How long focus must rest on this card before the preview is mounted. Long
// enough that a held arrow never reaches it, short enough to feel immediate.
const PREVIEW_ARM_DELAY_MS = 400;
// No `playing` within this window → stop trying for this focus.
const PREVIEW_WATCHDOG_MS = 1200;

/**
 * Scenes whose preview reported an error, so they are never tried again.
 *
 * Module-level, because the alternative is re-requesting a 404 every time the
 * user passes over the card. Partitioned by data source: a module-level Map
 * outlives the `dataKey` remount that clears React state, so without the key a
 * scene marked bad against one server would stay bad after the user pointed the
 * app at another. Same reasoning as listCache.js.
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
 * The resolution half of the card's bottom-right badge — Stash writes
 * "1080P 20:04" there and the value has been on the object all along
 * (`normalizeScene` carries `file.height`), just never shown.
 *
 * The buckets are coarse on purpose. A card is read at ten feet: "1080P"
 * and "720P" are the distinction anyone can make at that distance, and the
 * exact pixel height is a detail for the detail page. 2160 gets a name
 * because "2160P" is not what anyone calls it.
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
 * `list` is the listing this card belongs to — the array, its total, the
 * page it stopped at and the closure that fetched it. It is opaque here;
 * the card only hands it back up on select/long-press so that a queue
 * opened from this card can continue in the order the user was looking at
 * rather than re-deriving it. See usePlayQueue.
 *
 * `onLongPress` is optional, and its absence is what keeps every other card
 * in the app on the old instant-on-keydown behaviour — see the long-press
 * note in useFocusable.
 */
export default function VideoCard({
  item, index, list, onSelect, onLongPress,
  // The showroom gives its scene shelf its own focus-id namespace, distinct
  // from both the numbered `video-` ids of the Scenes listing and the other
  // shelf families (`studio-`, `performer-`, `gallery-`). The registry is a
  // keyed Map, and a shelf card's id doubling a listing card's would let one
  // overwrite the other. The default is the grid's original scheme.
  focusIdPrefix = 'video',
  // Only the first card of the top shelf may claim focus on mount; the
  // showroom passes `false` for every other shelf rather than letting four
  // shelves race for it.
  autoFocus = index === 0,
  // An optional explicit edge per direction, the same mechanism the rail's
  // rows use. The showroom's top shelf passes `{ up: 'nav-home' }`: with no
  // controls bar on Home, the geometry sends Up to whichever rail row is
  // nearest the shelf's centre — Scenes, the row below the active one — and
  // landing on a row you are not looking at is the jump the user reported.
  // Up mirrors Left's rule ("return to the tab you are on"). The grid passes
  // nothing and keeps the geometry.
  nextId = null,
  // Home gives every shelf card one fixed height. `fill` lets this card's
  // thumbnail take whatever the info bar leaves instead of holding 16:9, so
  // the scene shelf matches the three overlay card families exactly. Listings
  // pass nothing and keep their aspect ratio.
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

  // All four have to hold: the user asked for previews, this is not mock data
  // (whose previews are null and whose thumbnails are external), the scene has
  // a URL to try, and this scene has not already failed.
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

    // Re-checked on a loop rather than once, because the case that matters is a
    // *held* arrow that stops at the edge of the grid: focus never moves again,
    // so `is-navigating` can still be set when a single check would run. One
    // check would simply never arm, and the card now under the cursor would
    // have no preview for no reason the user could see.
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
    // `playing` is a dependency and not just a guard, so that the timer is
    // *cleared* the moment a frame arrives. Without it the watchdog fires
    // anyway a second or so into a perfectly good preview, sets `gaveUp`, and
    // unmounts the element — the clip would play for 1.2 s and then vanish.
    if (!armed || playing) return;
    const t = setTimeout(() => {
      // No frame in time. Stop for this focus and let the cover stay.
      //
      // Deliberately NOT recorded in `badPreviews`: this window cannot tell a
      // slow preview from an absent one, and the persistent case — a 404 —
      // reports itself through `onError` below. Blacklisting on a timeout would
      // turn one slow response into a card that never previews again.
      setGaveUp(true);
    }, PREVIEW_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [armed, playing]);

  // Muted is set on the element rather than passed as a prop, because React
  // applies `muted` after the element is in the tree and autoplay has already
  // begun by then — the browser then refuses to start an unmuted video and the
  // preview silently never plays.
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
