/**
 * ImageViewer, full-screen view of one image, with the listing around it.
 *
 * Borrows the overlay idiom: `role="dialog"` for the focus trap, and Back on
 * the capture phase so it closes this rather than reaching App's `onBack` and
 * raising the exit prompt behind it. See ActionMenu.
 *
 * ## Focus
 *
 * The surface itself is focusable and autofocuses, load-bearing, not tidy: if
 * focus stayed on the card behind, Left/Right would move the grid's focus *and*
 * step this image, since the grid is still mounted underneath.
 *
 * The slideshow's Play/Pause and Info are header buttons for the same reason:
 * the viewer opens on Enter, and a surface binding would let that press's
 * auto-repeat toggle them thirty times. Focus path is surface → Up → Info →
 * Left → Play, so the D-pad never needs a letter key. The media keys (play,
 * pause, play/pause) work anywhere, like the player's.
 *
 * ## Slideshow
 *
 * `autoPlay` advances every SLIDE_MS, preloading the next picture. It stops at
 * the last image rather than looping, pauses while the info panel is open and
 * resumes on close, and any manual Left/Right stops it, browsing is a decision,
 * not a nudge to the timer. In gallery mode it holds on the last picture in
 * hand while the background loop is still fetching and stops only at the real
 * end, so a slideshow that outran a slow server does not stop halfway.
 *
 * ## Two sources
 *
 * From an image card it steps through the listing snapshot it was handed and
 * stops at either end rather than paging in more. From a gallery's menu there
 * is no listing to snapshot, so it fetches the gallery itself: first page,
 * open, then page the rest in behind the curtain, capped at GALLERY_MAX_PAGES.
 * The footer's "of N loaded" stays honest about what is in hand.
 *
 * "Shuffle" asks the server for a seeded random order rather than shuffling
 * per page: per-page shuffling always began inside the newest 40 pictures, and
 * the seed makes the draw fresh per open but consistent across its pages (see
 * randomSort.js). Those pages bypass the list cache: up to 100 would evict
 * every page the rest of the app can still show.
 */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { isBackCode } from '../utils/input.js';
import { fetchImageInfo, fetchImages } from '../utils/imageService.js';
import { buildImageInfoRows } from '../utils/imageInfo.js';
import { stableSort } from '../utils/randomSort.js';
import styles from './ImageViewer.module.css';

// Collapses a held arrow's key repeat into one request while still feeling
// immediate; stepping changes `item` at repeat rate and the cache only helps
// on the way back.
const INFO_FETCH_DELAY_MS = 180;

// Long enough to read a photograph, short enough not to feel stalled. Not
// configurable: one sensible pace, not one more Settings entry.
const SLIDE_MS = 6000;

const GALLERY_PAGE_SIZE = 40;
// 4,000 images. A cap so one pathological gallery cannot hold the loop open;
// Back out to View images, which lists every one, is the escape hatch.
const GALLERY_MAX_PAGES = 100;

export default function ImageViewer({
  items = [],
  index = 0,
  gallery = null,
  shuffle = false,
  autoPlay = false,
  initialInfoOpen = false,
  onClose,
  onIndexChange,
}) {
  const [imgError, setImgError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(!!autoPlay);

  // Read-only. A header button rather than a surface key: the viewer opens on
  // Enter, and a surface binding would let that press's repeats toggle it.
  const [infoOpen, setInfoOpen] = useState(!!initialInfoOpen);
  const [infoStatus, setInfoStatus] = useState('idle'); // idle | loading | ready | error
  const [infoData, setInfoData] = useState(null);
  const [infoMessage, setInfoMessage] = useState('');
  const currentIdRef = useRef(null);

  // Gallery mode only: null while the first page is in flight. `galleryIndex`
  // is local because there is no App-held listing to index into.
  const [galleryItems, setGalleryItems] = useState(null);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryStatus, setGalleryStatus] = useState('idle'); // idle | loading | ready | error
  const [galleryMessage, setGalleryMessage] = useState('');
  // False while the background loop is still paging the gallery in. The
  // slideshow uses it to tell "this is the last picture" apart from "the last
  // picture I have so far", see the slide timer below.
  const [galleryDone, setGalleryDone] = useState(false);
  const preloadRef = useRef(null);

  const { ref } = useFocusable({
    id: 'image-viewer',
    zone: 'image-viewer',
    autoFocus: true,
    nextId: { up: 'image-viewer-info' },
  });
  const playBtn = useFocusable({
    id: 'image-viewer-play',
    zone: 'image-viewer',
    nextId: { right: 'image-viewer-info', down: 'image-viewer' },
    onEnter: () => setPlaying(p => !p),
  });
  const infoBtn = useFocusable({
    id: 'image-viewer-info',
    zone: 'image-viewer',
    nextId: { left: 'image-viewer-play', down: 'image-viewer' },
    // `onEnter`, not just `onClick`: useFocusable prevents native button
    // activation on Enter, so `onClick` alone never fires from the remote. Same
    // convention as tvActions.ActionButton. `closeInfo` is hoisted below.
    onEnter: () => (infoOpen ? closeInfo() : setInfoOpen(true)),
  });

  // Memoized because the effect that preloads the next picture keys on it,
  // and the default `items = []` is a fresh array every render.
  const sourceItems = useMemo(
    () => (gallery ? (galleryItems || []) : items),
    [gallery, galleryItems, items],
  );
  const currentIndex = gallery ? galleryIndex : index;
  const item = sourceItems[currentIndex] || null;
  const itemId = item?.id ?? null;
  const canPrev = currentIndex > 0;
  const canNext = currentIndex < sourceItems.length - 1;

  // App builds `onIndexChange` inline. A ref keeps `goTo` stable, it is in the
  // slide timer's dependencies, where an unstable identity would restart the
  // six-second countdown on any unrelated re-render and tear down the key
  // listener with it.
  const onIndexChangeRef = useRef(onIndexChange);
  useEffect(() => { onIndexChangeRef.current = onIndexChange; });

  const goTo = useCallback((next) => {
    if (gallery) setGalleryIndex(next);
    else onIndexChangeRef.current?.(next);
  }, [gallery]);

  // Reset on picture change, or the second image inherits the first's failure
  // and shows the fallback.
  useEffect(() => { setImgError(false); setLoaded(false); }, [item?.id]);

  // Stepping races the info request: image 5's answer can land after the
  // viewer is on image 6. The resolve checks this ref.
  useEffect(() => { currentIdRef.current = item?.id ?? null; }, [item?.id]);

  // Only while the panel is open, stepping with it closed must not issue a
  // request per image. The delay collapses a held arrow's repeat, so only the
  // image the user settles on is queried.
  useEffect(() => {
    if (!infoOpen || !item?.id) return undefined;
    let cancelled = false;
    const requestedId = item.id;
    setInfoStatus('loading');
    setInfoMessage('');
    const timer = setTimeout(() => {
      fetchImageInfo(item)
        .then(d => {
          if (cancelled || currentIdRef.current !== requestedId) return;
          if (!d) {
            setInfoData(null);
            setInfoStatus('error');
            setInfoMessage('No metadata was found.');
            return;
          }
          setInfoData(d);
          setInfoStatus('ready');
        })
        .catch(e => {
          if (cancelled || currentIdRef.current !== requestedId) return;
          setInfoData(null);
          setInfoStatus('error');
          setInfoMessage(e.message);
        });
    }, INFO_FETCH_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [infoOpen, item]);

  // ── Gallery mode: fetch the gallery's pictures ─────────────
  // First page opens the viewer; the rest append in the background so a large
  // gallery does not delay the first picture.
  useEffect(() => {
    if (!gallery?.id) return undefined;
    let cancelled = false;
    setGalleryItems(null);
    setGalleryIndex(0);
    setGalleryStatus('loading');
    setGalleryMessage('');
    setGalleryDone(false);

    // One permutation for the whole gallery, fresh each open: `stableSort`
    // hashes this identity, and `Math.random()` is what varies between opens.
    // Unseeded, the server re-shuffles per request, so page 2 would overlap
    // page 1 and the slideshow could see a "last" picture that is not one.
    const sort = shuffle
      ? stableSort('random', 'gallery', gallery.id, Math.random())
      : 'created_at';

    (async () => {
      const seen = new Set();
      let all = [];
      try {
        for (let page = 1; page <= GALLERY_MAX_PAGES; page++) {
          const d = await fetchImages({
            filter: { galleries: { modifier: 'INCLUDES', value: [gallery.id] } },
            // Newest first, matching the Images tab. A seeded random sort
            // ignores the direction, as the server does.
            sort,
            order: 'desc',
            page,
            limit: GALLERY_PAGE_SIZE,
            // Must not evict the 50-entry list cache the rest of the app is
            // browsing from.
            cache: false,
          });
          if (cancelled) return;
          const rows = (d.images || []).filter(x => x?.id && !seen.has(String(x.id)));
          rows.forEach(x => seen.add(String(x.id)));
          all = [...all, ...rows];
          setGalleryItems(all);
          setGalleryStatus('ready');
          // A short page means the server has nothing more; `all.length >=
          // total` covers the same ground when the server's total is exact.
          if ((d.images || []).length < GALLERY_PAGE_SIZE) break;
          if (Number(d.total) && all.length >= Number(d.total)) break;
        }
        if (!cancelled) setGalleryDone(true);
      } catch (e) {
        if (cancelled) return;
        // A later page failing must not blank a slideshow already showing:
        // keep what arrived and stop extending. Either way the loop is over
        // and the slideshow may stop at the end again.
        setGalleryDone(true);
        if (all.length) return;
        setGalleryStatus('error');
        setGalleryMessage(e.message || 'Unknown error');
      }
    })();

    return () => { cancelled = true; };
  }, [gallery?.id, shuffle]);

  // ── The slideshow ─────────────────────────────────────────
  // Not while the info panel is open: the user asked to read about this
  // picture, and stepping away would answer a question they did not ask.
  // Closing resumes (`playing` is still true), opening Info is a browse
  // action, not a stop.
  useEffect(() => {
    if (!playing || infoOpen || !itemId) return undefined;
    if (!canNext) {
      // Gallery mode: the loop may still be bringing pictures in. This is the
      // last one *in hand*, so hold, the effect re-runs when the next page
      // lands (`canNext` flips) and falls through when the loop reports its
      // end (`galleryDone`).
      if (gallery && !galleryDone) return undefined;
      setPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => goTo(currentIndex + 1), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [playing, infoOpen, itemId, canNext, currentIndex, gallery, galleryDone, goTo]);

  // Warm the next picture while the current one is up. Only while running:
  // manual browsing should not pull a full-resolution file per step. Held in a
  // ref so the browser does not discard the load with the Image object.
  useEffect(() => {
    if (!playing || infoOpen) return;
    const next = sourceItems[currentIndex + 1];
    const src = next?.full || next?.image_path;
    if (!src) return;
    const img = new Image();
    img.src = src;
    preloadRef.current = img;
  }, [playing, infoOpen, sourceItems, currentIndex]);

  const closeInfo = useCallback(() => {
    setInfoOpen(false);
    ref.current?.focus();
  }, [ref]);

  // A *layout* effect, deliberately. The closure reads the index it was
  // registered with, and the slideshow changes that index on a timer. A
  // passive effect lands one task after the advance's commit, so a keydown in
  // between runs the old closure, index 0 on the advance away from 0, whose
  // `canPrev` is false, and the arrow is silently dropped. Layout effects run
  // inside the commit, closing that window (a flaky harness check caught it:
  // same tree, 36/40 vs 40/40).
  useLayoutEffect(() => {
    const handler = (e) => {
      // Media keys mean play/pause anywhere in the overlay, as in the player
      // (see usePlayerTransport for why 415 and 19 are split).
      if (e.keyCode === 10252) {
        e.preventDefault();
        e.stopPropagation();
        setPlaying(p => !p);
        return;
      }
      if (e.keyCode === 19) {
        e.preventDefault();
        e.stopPropagation();
        setPlaying(false);
        return;
      }
      if (e.keyCode === 415) {
        e.preventDefault();
        e.stopPropagation();
        setPlaying(true);
        return;
      }
      if (e.key === 'Escape' || e.key === 'Backspace' || isBackCode(e.keyCode)) {
        e.preventDefault();
        e.stopPropagation();
        // Back peels one layer at a time: the panel first, then the viewer.
        if (infoOpen) closeInfo();
        else onClose?.();
        return;
      }
      // ArrowLeft/ArrowRight only, not the TV's channel keys. With the panel
      // closed and the Info button focused, the arrows belong to the D-pad:
      // changing the picture behind a focused button would be invisible. With
      // the panel open they browse anyway, the footer advertises ◀ ▶ Browse
      // and the panel reloads for the new image without a Down press first.
      if (!infoOpen && document.activeElement !== ref.current) return;
      if (e.key === 'ArrowLeft' && canPrev) {
        e.preventDefault();
        e.stopPropagation();
        setPlaying(false);
        goTo(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && canNext) {
        e.preventDefault();
        e.stopPropagation();
        setPlaying(false);
        goTo(currentIndex + 1);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [currentIndex, canPrev, canNext, onClose, infoOpen, closeInfo, ref, goTo]);

  if (!gallery && !item) return null;

  // `full` is the full-resolution file and `image_path` the thumbnail; the
  // service puts both through withApiKey. The fallback covers a row whose
  // `paths.image` came back empty, Stash can still serve its thumbnail.
  const src = item ? (item.full || item.image_path) : null;
  // Never draw the previous image's metadata under the new one while the
  // next request is in flight.
  const infoRows = item && infoData && infoData.id === item.id
    ? buildImageInfoRows(infoData)
    : [];
  const title = gallery ? (gallery.title || 'Gallery') : (item?.title || 'Image');
  const empty = gallery && galleryStatus === 'ready' && !item;

  return (
    <div
      ref={ref}
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div className={styles.stage}>
        {gallery && !item && !empty && (
          galleryStatus === 'error' ? (
            <p className={styles.unavailable}>
              Couldn't load this gallery's images{galleryMessage ? `: ${galleryMessage}` : ''}.
            </p>
          ) : (
            <>
              <div className={styles.spinner} />
              <p className={styles.unavailable}>Loading images…</p>
            </>
          )
        )}

        {empty && (
          <p className={styles.unavailable}>This gallery has no images.</p>
        )}

        {item && (src && !imgError ? (
          <>
            {!loaded && <div className={styles.spinner} />}
            <img
              key={item.id}
              src={src}
              alt=""
              className={`${styles.image} ${loaded ? styles.imageLoaded : ''}`}
              onLoad={() => setLoaded(true)}
              onError={() => setImgError(true)}
              draggable={false}
            />
          </>
        ) : (
          <p className={styles.unavailable}>This image could not be loaded.</p>
        ))}

        {infoOpen && (
          <aside className={styles.infoPanel} aria-label="Image info">
            {infoStatus === 'loading' && (
              <p className={styles.infoState}>Loading info…</p>
            )}
            {infoStatus === 'error' && (
              <p className={styles.infoState}>
                Couldn't load info{infoMessage ? `: ${infoMessage}` : ''}
              </p>
            )}
            {infoStatus === 'ready' && (
              <dl className={styles.infoRows}>
                {infoRows.map(row => (
                  <div key={row.key} className={styles.infoRow}>
                    <dt>{row.label}</dt>
                    <dd className={row.clamp ? styles.infoClamp : undefined}>{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </aside>
        )}
      </div>

      <header className={styles.bar}>
        <h2 className={styles.title}>{title}</h2>
        <div className={styles.meta}>
          {item?.date && <span>{item.date}</span>}
          {item?.rating && <span className={styles.rating}>★ {item.rating}</span>}
        </div>
        <div className={styles.actions}>
          <button
            ref={playBtn.ref}
            className={`${styles.infoBtn} ${styles.playBtn} ${playBtn.focused ? styles.infoBtnFocused : ''}`}
            onClick={() => setPlaying(p => !p)}
            aria-pressed={playing}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            ref={infoBtn.ref}
            className={`${styles.infoBtn} ${infoBtn.focused ? styles.infoBtnFocused : ''}`}
            onClick={() => (infoOpen ? closeInfo() : setInfoOpen(true))}
            aria-pressed={infoOpen}
          >
            Info
          </button>
        </div>
      </header>

      <footer className={styles.footer}>
        {/* The position is against what this viewer has in hand: the grid's
            snapshot (which can be 40 of 31,251) or the pages fetched so far.
            "of N loaded" is the honest claim either way. */}
        {sourceItems.length > 0 && (
          <span className={styles.counter}>
            {currentIndex + 1} <span className={styles.counterSep}>of</span> {sourceItems.length} loaded
          </span>
        )}
        <span className={styles.hint}>
          <kbd>▲</kbd> Info
          {canPrev || canNext ? <><kbd>◀</kbd> <kbd>▶</kbd> Browse</> : null}
          <kbd>Back</kbd> Close
        </span>
      </footer>
    </div>
  );
}
