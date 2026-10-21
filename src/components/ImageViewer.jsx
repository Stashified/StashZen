/**
 * ImageViewer — full-screen view of one image, with the listing around it.
 *
 * There was no full-screen media surface except the video player, so this is
 * new rather than a variation: `VideoPlayer` owns a <video> element, transport
 * controls, and a queue that pages itself through `usePlayQueue`. None of that
 * applies. What is borrowed is the *overlay* idiom — `role="dialog"` for the
 * focus trap, and Back handled on the capture phase so it closes this rather
 * than reaching App's `onBack` and raising the exit prompt behind it. See
 * ActionMenu.
 *
 * ## Focus
 *
 * The surface itself is the focusable element, and it autofocuses. That is
 * load-bearing rather than tidy: if focus stayed on the card behind, a
 * Left/Right press would move the grid's focus *and* step this image, because
 * the grid is still mounted underneath and both handlers would fire.
 *
 * Unlike ActionMenu this does not wait for the opening press to end. The menu
 * needed to because it is opened by a *long* press and would otherwise aim that
 * press's auto-repeats at its first row; this is opened by a plain Enter, and
 * Enter means nothing here, so the repeats are inert either way.
 *
 * The slideshow's Play/Pause is a header button for the same reason the info
 * panel is: the viewer opens on Enter, and a surface binding would let that
 * press's auto-repeat toggle it thirty times. Its focus path is
 * surface → Up → Info → Left → Play, so the D-pad never needs to know a
 * letter key. The media keys (play/pause, play, pause) work anywhere in the
 * overlay, like the player's.
 *
 * ## Slideshow
 *
 * `autoPlay` advances once every SLIDE_MS, preloading the next picture while
 * the current one is on screen. It stops at the last image rather than
 * looping, pauses while the info panel is open (and resumes when it closes),
 * and any manual Left/Right stops it — a browse gesture is a decision about
 * what to look at next, not a nudge to the timer. Back does not need to stop
 * it; the viewer unmounts. In gallery mode it *holds* on the last picture in
 * hand while the background loop is still fetching, and stops only at the
 * real end — otherwise a slideshow that outran a slow server would stop
 * halfway through the gallery.
 *
 * ## Two sources
 *
 * Opened from an image card, it steps through the listing snapshot it was
 * handed — the array the grid had loaded at that moment — and stops at either
 * end rather than paging in more. That stays true: paging from inside the
 * viewer is a real feature and not a small one, because the grid's own
 * `fetchPage` lives in `usePagedList` two components down.
 *
 * Opened from a *gallery's* menu (`gallery` prop), there is no listing to
 * snapshot — the pictures are the gallery's, and the card is a container. So
 * this fetches them itself: fill the first page, open, then page the rest in
 * behind the curtain while the viewer is already usable. A gallery can be
 * arbitrarily large, so the loop is capped at GALLERY_MAX_PAGES; the footer's
 * "of N loaded" stays honest about how many are in hand.
 *
 * "Shuffle" asks the server for a seeded random order rather than shuffling
 * each page as it arrives. Per-page shuffling meant a shuffled slideshow
 * always began inside the newest 40 pictures, and — now that the pages join
 * one order — the draw is fresh on every open but consistent across the
 * pages of one open (see randomSort.js). Those background pages bypass the
 * list cache: up to 100 of them would evict every page the rest of the app
 * can still show.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { TIZEN_BACK } from '../utils/input.js';
import { fetchImageInfo, fetchImages } from '../utils/imageService.js';
import { buildImageInfoRows } from '../utils/imageInfo.js';
import { stableSort } from '../utils/randomSort.js';
import styles from './ImageViewer.module.css';

// Long enough to collapse a held arrow's key repeat into one request, short
// enough that opening the panel still feels immediate. Stepping changes
// `item` at repeat rate, and the cache only helps on the way *back* — without
// this, every image passed on the way out was queried for a panel that had
// already moved on.
const INFO_FETCH_DELAY_MS = 180;

// Six seconds: long enough to read a photograph, short enough that a
// slideshow does not feel stalled. Not configurable — a TV setting for it
// would be one more thing in Settings for a feature with one sensible pace.
const SLIDE_MS = 6000;

const GALLERY_PAGE_SIZE = 40;
// 100 pages is 4,000 images. A cap rather than "until the server says stop"
// so one pathological gallery cannot hold the loop open indefinitely; when it
// is reached the footer already says "loaded", and Back out to View images
// (which lists every one) is the escape hatch.
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

  // The info panel is read-only. It is a header button rather than a key on
  // the surface because the viewer is opened by Enter, and binding Enter to
  // the surface would let that press's auto-repeats toggle the panel.
  const [infoOpen, setInfoOpen] = useState(!!initialInfoOpen);
  const [infoStatus, setInfoStatus] = useState('idle'); // idle | loading | ready | error
  const [infoData, setInfoData] = useState(null);
  const [infoMessage, setInfoMessage] = useState('');
  const currentIdRef = useRef(null);

  // Gallery mode only: null while the first page is in flight, then the
  // pictures. `galleryIndex` is local because there is no App-held listing
  // behind it to index into.
  const [galleryItems, setGalleryItems] = useState(null);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryStatus, setGalleryStatus] = useState('idle'); // idle | loading | ready | error
  const [galleryMessage, setGalleryMessage] = useState('');
  // False while the background loop is still paging the gallery in. The
  // slideshow uses it to tell "this is the last picture" apart from "the last
  // picture I have so far" — see the slide timer below.
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
    // `onEnter`, not just `onClick`: useFocusable prevents the native button
    // activation on Enter (see its longPress branch), so a button that only
    // carries `onClick` never fires from the remote. Same convention as
    // tvActions.ActionButton. `closeInfo` is defined below — the arrow body
    // runs on a key event, long after the render that created it.
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

  // App builds `onIndexChange` inline, so it is a new function on every App
  // render. It is only ever called from an event or a timer, so a ref keeps
  // `goTo` stable — and `goTo` is in the slide timer's dependencies, where an
  // unstable identity would restart the six-second countdown on any unrelated
  // re-render and tear down the key listener with it (the review's R4).
  const onIndexChangeRef = useRef(onIndexChange);
  useEffect(() => { onIndexChangeRef.current = onIndexChange; });

  const goTo = useCallback((next) => {
    if (gallery) setGalleryIndex(next);
    else onIndexChangeRef.current?.(next);
  }, [gallery]);

  // Reset the per-image state whenever the picture changes, or the second
  // image inherits the first one's failure and shows the fallback.
  useEffect(() => { setImgError(false); setLoaded(false); }, [item?.id]);

  // Stepping races the info request: the answer for image 5 can land after
  // the viewer is already on image 6. The ref is what the resolve checks.
  useEffect(() => { currentIdRef.current = item?.id ?? null; }, [item?.id]);

  // Fetch only while the panel is open — stepping through a listing with the
  // panel closed must not issue one request per image. The short delay
  // collapses a held arrow's key repeat: only the image the user settles on
  // is queried, rather than every image passed on the way there.
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
  // First page opens the viewer; the rest are appended in the background so a
  // large gallery does not make the user wait before the first picture.
  useEffect(() => {
    if (!gallery?.id) return undefined;
    let cancelled = false;
    setGalleryItems(null);
    setGalleryIndex(0);
    setGalleryStatus('loading');
    setGalleryMessage('');
    setGalleryDone(false);

    // One permutation for the whole gallery, drawn fresh on each open:
    // `stableSort` hashes the identity it is given, and the extra
    // `Math.random()` part is what varies between opens. Without a seed the
    // server re-shuffles per request, so page 2 would overlap page 1 and the
    // slideshow below could see a "last" picture that is not one.
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
            // Newest first, matching the Images tab's default. A seeded
            // random sort ignores the direction, as the server does.
            sort,
            order: 'desc',
            page,
            limit: GALLERY_PAGE_SIZE,
            // A background loop must not evict the 50-entry list cache the
            // rest of the app is browsing from.
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
        // A later page failing must not blank a slideshow that is already
        // showing: keep what arrived and stop extending. Either way the loop
        // is over, and the slideshow may stop at the end again.
        setGalleryDone(true);
        if (all.length) return;
        setGalleryStatus('error');
        setGalleryMessage(e.message || 'Unknown error');
      }
    })();

    return () => { cancelled = true; };
  }, [gallery?.id, shuffle]);

  // ── The slideshow ─────────────────────────────────────────
  // Not while the info panel is open: the panel is the user asking to read
  // about this picture, and stepping away underneath it would answer a
  // question they did not ask. Closing the panel resumes (playing is still
  // true) — pausing a *slideshow* by opening Info is a browse action, not a
  // stop.
  useEffect(() => {
    if (!playing || infoOpen || !itemId) return undefined;
    if (!canNext) {
      // Gallery mode: the loop may still be bringing pictures in. This is the
      // last one *in hand*, not necessarily the last one, so hold — the effect
      // re-runs and starts a fresh countdown when the next page lands
      // (`canNext` flips), and falls through to the stop below when the loop
      // reports its end (`galleryDone`). See the header.
      if (gallery && !galleryDone) return undefined;
      setPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => goTo(currentIndex + 1), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [playing, infoOpen, itemId, canNext, currentIndex, gallery, galleryDone, goTo]);

  // Warm the next picture while the current one is up. Only while running:
  // browsing by hand should not pull a full-resolution file per step. The
  // Image object is held in a ref so the browser does not discard the load
  // with it.
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

  useEffect(() => {
    const handler = (e) => {
      // The media keys mean play/pause anywhere in the overlay, as they do in
      // the player (see usePlayerTransport for why 415 and 19 are split).
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
      if (e.key === 'Escape' || e.key === 'Backspace' || e.keyCode === TIZEN_BACK) {
        e.preventDefault();
        e.stopPropagation();
        // Back peels one layer at a time: the panel first, then the viewer.
        if (infoOpen) closeInfo();
        else onClose?.();
        return;
      }
      // ArrowLeft/ArrowRight only — not the TV's channel keys. Stepping is a
      // browse gesture and the arrows are what the rest of the app uses for it.
      // While the panel is closed and the Info button holds focus, the arrows
      // belong to the D-pad rather than the picture: changing what is on screen
      // behind a focused button would be invisible. With the panel open they
      // browse anyway — keeping it open while stepping is the point, and the
      // footer advertises ◀ ▶ Browse — so the panel reloads for the new image
      // without a Down press first. (Reported from the TV on 0.29.0: Left/Right
      // did nothing until the panel was closed.)
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
  // service puts both through withApiKey. Falling back to the thumbnail is for
  // a row whose `paths.image` came back empty, which does happen — a file Stash
  // knows about but cannot serve still has a thumbnail route.
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
              Couldn't load this gallery's images{galleryMessage ? ` — ${galleryMessage}` : ''}.
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
                Couldn't load info{infoMessage ? ` — ${infoMessage}` : ''}
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
        {/* The position is against what this viewer has in hand. Opened from
            an image card that is the grid's snapshot, which can be fewer than
            the listing's total — the grid had loaded 40 of 31,251 when the
            card was pressed. In gallery mode it is the pages fetched so far.
            Either way "of N loaded" is the honest claim. */}
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
