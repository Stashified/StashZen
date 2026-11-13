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
 * The Slideshow and Info buttons are header buttons for the same reason: the
 * viewer opens on Enter, and a surface binding would let that press's
 * auto-repeat toggle them thirty times. Focus path is surface → Up → Info →
 * Left → Slideshow, so the D-pad never needs a letter key. The media keys
 * (play, pause, play/pause) work anywhere, like the player's.
 *
 * ## Slideshow
 *
 * `autoPlay` advances on the configured slideshow interval, preloading the next
 * picture. It stops at the last image rather than looping, and any manual
 * Left/Right stops it,
 * browsing is a decision, not a nudge to the timer. The info panel does not
 * pause it: the panel follows the picture that is on screen, and the header
 * button reads Stop slideshow while it runs. In gallery mode it holds on the
 * last picture in hand while the background loop is still fetching and stops
 * only at the real end, so a slideshow that outran a slow server does not stop
 * halfway.
 *
 * ## Two sources
 *
 * From an image card it steps through the listing snapshot it was handed and
 * stops at either end rather than paging in more. From a gallery's menu there
 * is no listing to snapshot, so it fetches the gallery itself: first page,
 * open, then a runway of pages ahead of the playhead, capped at
 * GALLERY_MAX_PAGES. The footer's "of N loaded" stays honest about what is in
 * hand.
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
import {
  fetchImageInfo,
  fetchImages,
  updateImage,
  incrementImageO,
  decrementImageO,
  resetImageO,
} from '../utils/imageService.js';
import { buildImageInfoRows } from '../utils/imageInfo.js';
import { ratingLabel, nextRating } from '../utils/format.js';
import { stableSort } from '../utils/randomSort.js';
import { useSettings } from '../utils/settings.js';
import styles from './ImageViewer.module.css';

// Collapses a held arrow's key repeat into one request while still feeling
// immediate; stepping changes `item` at repeat rate and the cache only helps
// on the way back.
const INFO_FETCH_DELAY_MS = 180;

// Enter cycles these. Pan is in pixels, bounded per axis by how much the
// scaled picture actually overflows the stage: a portrait picture at 2× may
// still be narrower than a 16:9 stage, where any sideways pan would only
// reveal black. One press moves a twelfth of the picture, a step you can see
// without overshooting the edge.
const ZOOM_MAX = 3;
const PAN_STEP = 12.5;

function panLimit(zoom, picture, stage) {
  return Math.max(0, (zoom * picture - stage) / 2);
}

const GALLERY_PAGE_SIZE = 40;
// 4,000 images. A cap so one pathological gallery cannot hold the loop open;
// Back out to View images, which lists every one, is the escape hatch.
const GALLERY_MAX_PAGES = 100;
// Pages kept ahead of the picture on screen. The slideshow consumes one page
// every four minutes, a manual browse as fast as the user can press; two pages
// of slack is enough for the next page to land unseen.
const GALLERY_RUNWAY_PAGES = 3;

function EditButton({
  id, label, glyph, active, disabled, nextId, onEnter, onLongPress, onFocus, onBlur,
}) {
  const { ref, focused } = useFocusable({
    id,
    zone: 'image-viewer',
    onEnter,
    onLongPress,
    onFocus,
    onBlur,
    nextId,
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.editBtn} ${focused ? styles.editFocused : ''} ${disabled ? styles.editMuted : ''}`}
      onClick={onEnter}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-pressed={active}
    >
      {glyph}
    </button>
  );
}

function ImageEditControls({
  detail, busy, onRating, onOrganized,
  onOIncrement, onODecrement, onOReset, onFocusChange,
}) {
  const rating = Math.max(0, Math.min(100, Math.round(Number(detail.rating100) || 0)));
  // Show an off-grid value exactly (75 is 7.5), and step from it: rounding to
  // 8★ first would make one press write 90 or 60.
  const ratingDisplay = rating === 0
    ? '–'
    : (rating % 10 === 0 ? String(rating / 10) : (rating / 10).toFixed(1));
  const oCount = detail.oCounter || 0;

  const ratingDecNext = {
    right: 'image-viewer-rating-inc',
    down: 'image-viewer-organized',
    up: 'image-viewer-info',
  };
  const ratingIncNext = {
    left: 'image-viewer-rating-dec',
    down: 'image-viewer-organized',
    up: 'image-viewer-info',
  };
  const organizedNext = {
    up: 'image-viewer-rating-inc',
    down: 'image-viewer-o-dec',
  };
  const oDecNext = {
    right: 'image-viewer-o-inc',
    up: 'image-viewer-organized',
    down: 'image-viewer',
  };
  // Down returns to the picture, so browsing under the open panel still works.
  const oIncNext = {
    left: 'image-viewer-o-dec',
    up: 'image-viewer-organized',
    down: 'image-viewer',
  };

  return (
    <div
      className={styles.editControls}
      role="group"
      aria-label="Image actions"
      aria-busy={busy || undefined}
    >
      <div className={styles.editRow}>
        <span className={styles.editLabel}>Rating</span>
        <EditButton
          id="image-viewer-rating-dec"
          label="Decrease rating"
          glyph="−"
          disabled={rating <= 0 || busy}
          nextId={ratingDecNext}
          onEnter={() => onRating(nextRating(rating, -1))}
          onFocus={() => onFocusChange('image-viewer-rating-dec')}
          onBlur={() => onFocusChange(null)}
        />
        <span className={styles.editValue}>
          {ratingDisplay} <span aria-hidden="true">★</span>
        </span>
        <EditButton
          id="image-viewer-rating-inc"
          label="Increase rating"
          glyph="+"
          disabled={rating >= 100 || busy}
          nextId={ratingIncNext}
          onEnter={() => onRating(nextRating(rating, 1))}
          onFocus={() => onFocusChange('image-viewer-rating-inc')}
          onBlur={() => onFocusChange(null)}
        />
      </div>

      <div className={styles.editRow}>
        <span className={styles.editLabel}>Status</span>
        <EditButton
          id="image-viewer-organized"
          label={detail.organized ? 'Remove organised mark' : 'Mark organised'}
          glyph={detail.organized ? '✓ Organised' : '○ Organised'}
          active={!!detail.organized}
          disabled={busy}
          nextId={organizedNext}
          onEnter={onOrganized}
          onFocus={() => onFocusChange('image-viewer-organized')}
          onBlur={() => onFocusChange(null)}
        />
      </div>

      <div className={styles.editRow}>
        <span className={styles.editLabel}>O count</span>
        <EditButton
          id="image-viewer-o-dec"
          label="Decrease O count"
          glyph="−"
          disabled={oCount <= 0 || busy}
          nextId={oDecNext}
          onEnter={onODecrement}
          onFocus={() => onFocusChange('image-viewer-o-dec')}
          onBlur={() => onFocusChange(null)}
        />
        <span className={styles.editValue}>{oCount}</span>
        <EditButton
          id="image-viewer-o-inc"
          label="Increase O count, hold to clear"
          glyph="+"
          disabled={busy}
          nextId={oIncNext}
          onEnter={onOIncrement}
          onLongPress={onOReset}
          onFocus={() => onFocusChange('image-viewer-o-inc')}
          onBlur={() => onFocusChange(null)}
        />
      </div>
    </div>
  );
}

export default function ImageViewer({
  items = [],
  index = 0,
  gallery = null,
  shuffle = false,
  autoPlay = false,
  initialInfoOpen = false,
  onClose,
}) {
  // The slideshow pace is a setting; 6 s is the default that shipped.
  const { slideshowInterval: slideMs } = useSettings();
  // Which picture has arrived, not a bare flag: a preloaded next image can fire
  // its load event before React runs the effect that used to clear the flag,
  // which left the spinner up over an invisible picture for good.
  const [loadedId, setLoadedId] = useState(null);
  const [errorId, setErrorId] = useState(null);
  const [playing, setPlaying] = useState(!!autoPlay);
  // Milliseconds until the next slide, for the footer readout. Recomputed from
  // the clock rather than decremented so a stalled interval cannot drift.
  const [slideLeft, setSlideLeft] = useState(slideMs);
  // 1 is fit-to-screen. Enter cycles 1 → 2 → 3 → 1, and Back resets before it
  // closes. `pan` is a pixel offset from centre.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const imgRef = useRef(null);
  const stageRef = useRef(null);

  // Read-only. A header button rather than a surface key: the viewer opens on
  // Enter, and a surface binding would let that press's repeats toggle it.
  const [infoOpen, setInfoOpen] = useState(!!initialInfoOpen);
  const [infoStatus, setInfoStatus] = useState('idle'); // idle | loading | ready | error
  const [infoData, setInfoData] = useState(null);
  const [infoMessage, setInfoMessage] = useState('');
  const [editNotice, setEditNotice] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [focusedControl, setFocusedControlState] = useState(null);
  // The picture-change effect reads the last control that held focus. A ref,
  // so that effect does not need to re-run when focus moves.
  const focusedControlRef = useRef(null);
  const setFocusedControl = (id) => {
    focusedControlRef.current = id;
    setFocusedControlState(id);
  };
  const currentIdRef = useRef(null);
  // A write started after the info request; that answer is now stale.
  const infoEpochRef = useRef(0);
  const editBusyRef = useRef(false);

  // The picture on screen. Local, not App's: stepping must not re-render App
  // and the whole grid sitting behind this overlay, and the viewer reports the
  // index it landed on when it closes. `index` is only the starting point.
  const [localIndex, setLocalIndex] = useState(index);
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
  // The gallery fetch's cursor (sort, seen ids, next page); a ref because the
  // pump is async and must see the page it asked for, not a later render's.
  const pumpRef = useRef(null);
  const preloadRef = useRef(null);

  const { ref } = useFocusable({
    id: 'image-viewer',
    zone: 'image-viewer',
    autoFocus: true,
    nextId: { up: 'image-viewer-info' },
    // A zoom is a browse action: the slideshow must not step away while the
    // user is looking closer. Both halves of the guard are load-bearing: the
    // header buttons are children of this surface, so their Enter keydown
    // bubbles here, and a handler that moves focus back to the surface (Play
    // closing the info panel) makes the activeElement test true from under us.
    onEnter: (e) => {
      if (e?.target !== ref.current || document.activeElement !== ref.current) return;
      setPlaying(false);
      setZoom(z => (z >= ZOOM_MAX ? 1 : z + 1));
      setPan({ x: 0, y: 0 });
    },
  });
  const closeInfo = useCallback(() => {
    setInfoOpen(false);
    // The notice belongs to this panel; don't greet the next open with it.
    setEditNotice('');
    setFocusedControl(null);
    ref.current?.focus();
  }, [ref]);

  const togglePlaying = () => setPlaying(p => !p);

  // Memoized because the effect that preloads the next picture keys on it,
  // and the default `items = []` is a fresh array every render.
  const sourceItems = useMemo(
    () => (gallery ? (galleryItems || []) : items),
    [gallery, galleryItems, items],
  );
  const currentIndex = gallery ? galleryIndex : localIndex;
  const item = sourceItems[currentIndex] || null;
  const itemId = item?.id ?? null;
  const canPrev = currentIndex > 0;
  const canNext = currentIndex < sourceItems.length - 1;
  const loaded = itemId !== null && loadedId === itemId;
  const imgError = itemId !== null && errorId === itemId;
  // Controls and readouts only ever speak for the picture they were fetched
  // for; a stale answer from the previous image must not paint under this one.
  const detailForItem = item && infoData && String(infoData.id) === String(item.id)
    ? infoData
    : null;

  const playBtn = useFocusable({
    id: 'image-viewer-play',
    zone: 'image-viewer',
    nextId: { right: 'image-viewer-info', down: 'image-viewer' },
    onEnter: togglePlaying,
  });
  const infoBtn = useFocusable({
    id: 'image-viewer-info',
    zone: 'image-viewer',
    // Down enters the first control once it exists; while loading it must
    // still reach the picture.
    nextId: {
      left: 'image-viewer-play',
      down: infoOpen && detailForItem ? 'image-viewer-rating-dec' : 'image-viewer',
    },
    // `onEnter`, not just `onClick`: useFocusable prevents native button
    // activation on Enter, so `onClick` alone never fires from the remote. Same
    // convention as tvActions.ActionButton. `closeInfo` is hoisted below.
    onEnter: () => (infoOpen ? closeInfo() : setInfoOpen(true)),
  });
  // Stable, unlike the hook's returned object: the picture-change effect
  // focuses this button and must not re-run on every render.
  const focusInfoBtn = infoBtn.focus;

  const sameImage = (id) => currentIdRef.current != null
    && id != null
    && String(currentIdRef.current) === String(id);

  const beginEdit = () => {
    if (editBusyRef.current) return false;
    editBusyRef.current = true;
    setEditBusy(true);
    setEditNotice('');
    // A write started now outranks an info answer already in flight.
    infoEpochRef.current += 1;
    // Editing is a decision about this picture; stop the timer.
    setPlaying(false);
    return true;
  };
  const endEdit = () => {
    editBusyRef.current = false;
    setEditBusy(false);
  };
  const patchDetail = (id, patch) => {
    setInfoData(d => (d && String(d.id) === String(id) ? { ...d, ...patch } : d));
  };

  const editRating = async (rating100) => {
    const imageId = item?.id;
    if (!detailForItem || imageId == null || editBusyRef.current) return;
    const prev = detailForItem.rating100 ?? null;
    const next = Math.max(0, Math.min(100, Math.round(Number(rating100) || 0)));
    if ((prev ?? 0) === next || !beginEdit()) return;
    patchDetail(imageId, { rating100: next > 0 ? next : null });
    try {
      const saved = await updateImage({ id: imageId, rating100: next });
      patchDetail(imageId, { rating100: saved.rating100 });
    } catch (e) {
      patchDetail(imageId, { rating100: prev });
      if (sameImage(imageId)) setEditNotice(`Rating not saved: ${e.message}`);
    } finally {
      endEdit();
    }
  };

  const editOrganized = async () => {
    const imageId = item?.id;
    if (!detailForItem || imageId == null || editBusyRef.current) return;
    const prev = !!detailForItem.organized;
    const next = !prev;
    if (!beginEdit()) return;
    patchDetail(imageId, { organized: next });
    try {
      const saved = await updateImage({ id: imageId, organized: next });
      patchDetail(imageId, { organized: saved.organized ?? next });
    } catch (e) {
      patchDetail(imageId, { organized: prev });
      if (sameImage(imageId)) setEditNotice(`Organised mark not saved: ${e.message}`);
    } finally {
      endEdit();
    }
  };

  const incrementO = async () => {
    const imageId = item?.id;
    if (!detailForItem || imageId == null || editBusyRef.current) return;
    const prev = detailForItem.oCounter || 0;
    if (!beginEdit()) return;
    patchDetail(imageId, { oCounter: prev + 1 });
    try {
      const count = await incrementImageO(imageId, prev);
      if (typeof count === 'number') patchDetail(imageId, { oCounter: count });
    } catch (e) {
      patchDetail(imageId, { oCounter: prev });
      if (sameImage(imageId)) setEditNotice(`O count not saved: ${e.message}`);
    } finally {
      endEdit();
    }
  };

  const decrementO = async () => {
    const imageId = item?.id;
    if (!detailForItem || imageId == null || editBusyRef.current) return;
    const prev = detailForItem.oCounter || 0;
    if (prev <= 0) {
      setEditNotice('O count is already 0');
      return;
    }
    if (!beginEdit()) return;
    patchDetail(imageId, { oCounter: prev - 1 });
    try {
      const count = await decrementImageO(imageId, prev);
      if (typeof count === 'number') patchDetail(imageId, { oCounter: count });
    } catch (e) {
      patchDetail(imageId, { oCounter: prev });
      if (sameImage(imageId)) setEditNotice(`O count not saved: ${e.message}`);
    } finally {
      endEdit();
    }
  };

  const clearO = async () => {
    const imageId = item?.id;
    if (!detailForItem || imageId == null || editBusyRef.current) return;
    const prev = detailForItem.oCounter || 0;
    if (prev <= 0) {
      setEditNotice('O count is already 0');
      return;
    }
    if (!beginEdit()) return;
    patchDetail(imageId, { oCounter: 0 });
    try {
      const count = await resetImageO(imageId, prev);
      patchDetail(imageId, { oCounter: typeof count === 'number' ? count : 0 });
    } catch (e) {
      patchDetail(imageId, { oCounter: prev });
      if (sameImage(imageId)) setEditNotice(`O count not cleared: ${e.message}`);
    } finally {
      endEdit();
    }
  };

  // Stable: it is in the slide timer's dependencies, where a fresh identity
  // would restart the six-second countdown on any unrelated re-render and tear
  // down the key listener with it.
  const goTo = useCallback((next) => {
    if (gallery) setGalleryIndex(next);
    else setLocalIndex(next);
  }, [gallery]);

  // Reset on picture change, or the second image inherits the first's zoom and
  // pan. Load and error state are keyed by id instead, see above.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setEditNotice('');
    // A slide while a control holds focus unmounts it and drops focus to
    // <body>; land on Info instead.
    if (focusedControlRef.current) focusInfoBtn();
    setFocusedControl(null);
  }, [item?.id, focusInfoBtn]);

  // The preloader fetches the next picture during the six-second wait, so its
  // load can beat React's listener and leave a spinner over a picture that is
  // already there. `complete` answers for both orderings.
  useLayoutEffect(() => {
    const el = imgRef.current;
    if (!el || itemId === null) return;
    if (el.complete && el.naturalWidth > 0) setLoadedId(itemId);
  }, [itemId]);

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
    const epoch = ++infoEpochRef.current;
    setInfoStatus('loading');
    setInfoMessage('');
    const timer = setTimeout(() => {
      fetchImageInfo(item)
        .then(d => {
          if (cancelled || currentIdRef.current !== requestedId
            || epoch !== infoEpochRef.current) return;
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
          if (cancelled || currentIdRef.current !== requestedId
            || epoch !== infoEpochRef.current) return;
          setInfoData(null);
          setInfoStatus('error');
          setInfoMessage(e.message);
        });
    }, INFO_FETCH_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [infoOpen, item]);

  // ── Gallery mode: fetch the gallery's pictures ─────────────
  // Page 1 opens the viewer; later pages are fetched on demand, a runway of
  // GALLERY_RUNWAY_PAGES ahead of the picture on screen. Loading the whole
  // gallery would be up to GALLERY_MAX_PAGES requests racing a viewer that may
  // never leave the first picture; at one page per forty slides the runway is
  // many minutes of slideshow, and a manual step asks for the next page the
  // same way.
  useEffect(() => {
    if (!gallery?.id) return undefined;
    setGalleryItems(null);
    setGalleryIndex(0);
    setGalleryStatus('loading');
    setGalleryMessage('');
    setGalleryDone(false);

    // One permutation for the whole gallery, fresh each open: `stableSort`
    // hashes this identity, and `Math.random()` is what varies between opens.
    // Unseeded, the server re-shuffles per request, so page 2 would overlap
    // page 1 and the slideshow could see a "last" picture that is not one.
    pumpRef.current = {
      sort: shuffle ? stableSort('random', 'gallery', gallery.id, Math.random()) : 'created_at',
      seen: new Set(),
      // The next page to ask for, 1-based.
      next: 1,
      loading: false,
      done: false,
    };

    return () => { pumpRef.current = null; };
  }, [gallery?.id, shuffle]);

  // One page at a time, in order, so appends stay sorted. A stale pump (the
  // gallery changed under the request) is dropped by the identity check.
  const loadGalleryPage = useCallback(async () => {
    const s = pumpRef.current;
    if (!s || s.loading || s.done || !gallery?.id) return;
    s.loading = true;
    const page = s.next;
    try {
      const d = await fetchImages({
        filter: { galleries: { modifier: 'INCLUDES', value: [gallery.id] } },
        // Newest first, matching the Images tab. A seeded random sort ignores
        // the direction, as the server does.
        sort: s.sort,
        order: 'desc',
        page,
        limit: GALLERY_PAGE_SIZE,
        // Must not evict the 50-entry list cache the rest of the app is
        // browsing from.
        cache: false,
      });
      if (pumpRef.current !== s) return;
      const rows = (d.images || []).filter(x => x?.id && !s.seen.has(String(x.id)));
      rows.forEach(x => s.seen.add(String(x.id)));
      s.next = page + 1;
      if (rows.length) setGalleryItems(prev => [...(prev || []), ...rows]);
      setGalleryStatus('ready');
      // A short page means the server has nothing more; `seen >= total` covers
      // the same ground when the server's total is exact.
      if ((d.images || []).length < GALLERY_PAGE_SIZE) s.done = true;
      if (Number(d.total) && s.seen.size >= Number(d.total)) s.done = true;
      if (s.next > GALLERY_MAX_PAGES) s.done = true;
      if (s.done) setGalleryDone(true);
    } catch (e) {
      if (pumpRef.current !== s) return;
      // A later page failing must not blank a slideshow already showing: keep
      // what arrived and stop extending. Either way the loop is over and the
      // slideshow may stop at the end again.
      s.done = true;
      setGalleryDone(true);
      if (!s.seen.size) {
        setGalleryStatus('error');
        setGalleryMessage(e.message || 'Unknown error');
      }
    } finally {
      s.loading = false;
    }
  }, [gallery?.id]);

  // Top the runway up, and re-run when a page lands (the item count changes)
  // so the pump chains until the runway is full.
  useEffect(() => {
    if (!gallery?.id || !pumpRef.current) return;
    const pagesNeeded = Math.floor(galleryIndex / GALLERY_PAGE_SIZE) + GALLERY_RUNWAY_PAGES;
    if (pumpRef.current.next <= pagesNeeded) loadGalleryPage();
  }, [gallery?.id, galleryIndex, galleryItems?.length, loadGalleryPage]);

  // ── The slideshow ─────────────────────────────────────────
  // Runs with the info panel open too, so the panel is a readout of the picture
  // on screen and its fetch follows each step. Only a press stops it.
  useEffect(() => {
    if (!playing || !itemId) return undefined;
    if (!canNext) {
      // Gallery mode: the loop may still be bringing pictures in. This is the
      // last one *in hand*, so hold, the effect re-runs when the next page
      // lands (`canNext` flips) and falls through when the loop reports its
      // end (`galleryDone`).
      if (gallery && !galleryDone) return undefined;
      setPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => goTo(currentIndex + 1), slideMs);
    return () => clearTimeout(timer);
  }, [playing, itemId, canNext, currentIndex, gallery, galleryDone, goTo, slideMs]);

  // The countdown only exists while the timer does: same conditions, same
  // reset points, so the number on screen is the wait that is actually armed.
  useEffect(() => {
    setSlideLeft(slideMs);
    if (!playing || !itemId || !canNext) return undefined;
    const startedAt = Date.now();
    const tick = setInterval(() => {
      setSlideLeft(Math.max(0, slideMs - (Date.now() - startedAt)));
    }, 250);
    return () => clearInterval(tick);
  }, [playing, itemId, canNext, currentIndex, slideMs]);

  // Warm the next picture while the current one is up. Only while running:
  // manual browsing should not pull a full-resolution file per step. Held in a
  // ref so the browser does not discard the load with the Image object.
  useEffect(() => {
    if (!playing) return;
    const next = sourceItems[currentIndex + 1];
    const src = next?.full || next?.image_path;
    if (!src) return;
    const img = new Image();
    img.src = src;
    preloadRef.current = img;
  }, [playing, sourceItems, currentIndex]);

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
        // A held Back repeats; each repeat would re-run the ladder against the
        // new state and peel another layer. One press, one layer.
        if (e.repeat) return;
        // Back peels one layer at a time: the panel, then the zoom, then the
        // viewer.
        if (infoOpen) closeInfo();
        else if (zoom > 1) {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        // The index travels with the close: Back restores focus to the card on
        // screen, not the one the viewer opened on.
        } else onClose?.(currentIndex);
        return;
      }
      // While zoomed the arrows pan, and they must not also move focus off the
      // surface (Up would go to Info). The footer says so. The press moves the
      // window, not the picture: Right reveals the right side, as scrolling
      // does, so the image itself shifts the other way.
      if (!infoOpen && document.activeElement === ref.current && zoom > 1) {
        const dx = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
        const dy = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
        if (dx || dy) {
          e.preventDefault();
          e.stopPropagation();
          const img = imgRef.current;
          const stage = stageRef.current;
          if (!img || !stage) return;
          const w = img.offsetWidth;
          const h = img.offsetHeight;
          const limitX = panLimit(zoom, w, stage.clientWidth);
          const limitY = panLimit(zoom, h, stage.clientHeight);
          setPan(p => ({
            x: Math.max(-limitX, Math.min(limitX, p.x + (dx * w * PAN_STEP) / 100)),
            y: Math.max(-limitY, Math.min(limitY, p.y + (dy * h * PAN_STEP) / 100)),
          }));
          return;
        }
      }
      // ArrowLeft/ArrowRight only, not the TV's channel keys. With a header
      // button focused the arrows belong to the D-pad: changing the picture
      // behind a focused button reads as the button changing it, and the
      // selected ring is the only clue which thing a press acts on.
      if (document.activeElement !== ref.current) return;
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
  }, [currentIndex, canPrev, canNext, onClose, infoOpen, closeInfo, ref, goTo, zoom]);

  if (!gallery && !item) return null;

  // `full` is the full-resolution file and `image_path` the thumbnail; the
  // service puts both through withApiKey. The fallback covers a row whose
  // `paths.image` came back empty, Stash can still serve its thumbnail.
  const src = item ? (item.full || item.image_path) : null;
  // Never draw the previous image's metadata under the new one while the
  // next request is in flight.
  const infoRows = detailForItem ? buildImageInfoRows(detailForItem) : [];
  const headerRating = detailForItem
    ? ratingLabel(detailForItem.rating100)
    : (item?.rating || null);
  const title = gallery ? (gallery.title || 'Gallery') : (item?.title || 'Image');
  const empty = gallery && galleryStatus === 'ready' && !item;
  // One of the header buttons holds the D-pad; the footer then names its
  // neighbour instead of advertising a browse that the press will not do.
  const headerFocused = playBtn.focused || infoBtn.focused;

  return (
    <div
      ref={ref}
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div ref={stageRef} className={styles.stage}>
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
              ref={imgRef}
              src={src}
              alt=""
              className={`${styles.image} ${loaded ? styles.imageLoaded : ''}`}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              onLoad={() => setLoadedId(item.id)}
              onError={() => setErrorId(item.id)}
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
            {infoStatus === 'ready' && detailForItem && (
              <ImageEditControls
                detail={detailForItem}
                busy={editBusy}
                onRating={editRating}
                onOrganized={editOrganized}
                onOIncrement={incrementO}
                onODecrement={decrementO}
                onOReset={clearO}
                onFocusChange={setFocusedControl}
              />
            )}
            {editNotice && (
              <p className={styles.editNotice} role="status">{editNotice}</p>
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
          {headerRating && <span className={styles.rating}>★ {headerRating}</span>}
        </div>
        <div className={styles.actions}>
          <button
            ref={playBtn.ref}
            className={`${styles.infoBtn} ${styles.playBtn} ${playBtn.focused ? styles.infoBtnFocused : ''}`}
            onClick={togglePlaying}
            aria-pressed={playing}
          >
            {playing ? 'Stop slideshow' : 'Slideshow'}
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
            {zoom > 1 && <span className={styles.zoomLevel}>{zoom}×</span>}
            {playing && canNext && (
              <span className={styles.nextIn}>
                Next in {Math.max(1, Math.ceil(slideLeft / 1000))}s
              </span>
            )}
          </span>
        )}
        <span className={styles.hint}>
          {headerFocused ? (
            <>
              {infoBtn.focused
                ? <><kbd>◀</kbd> {playing ? 'Stop' : 'Slideshow'}</>
                : <><kbd>▶</kbd> Info</>}
              <kbd>▼</kbd> Picture
              <kbd>Back</kbd> {infoOpen ? 'Close info' : 'Close'}
            </>
          ) : focusedControl ? (
            <>
              <kbd>▲</kbd> <kbd>▼</kbd> Controls
              <kbd>OK</kbd> Change
              {focusedControl === 'image-viewer-o-inc' && (
                <><kbd>Hold OK</kbd> Clear O count</>
              )}
              <kbd>Back</kbd> Close info
            </>
          ) : zoom > 1 && !infoOpen ? (
            <>
              <kbd>◀</kbd> <kbd>▶</kbd> <kbd>▲</kbd> <kbd>▼</kbd> Pan
              <kbd>Enter</kbd> Zoom
              <kbd>Back</kbd> Reset
            </>
          ) : (
            <>
              <kbd>▲</kbd> Info
              {canPrev || canNext ? <><kbd>◀</kbd> <kbd>▶</kbd> Browse</> : null}
              <kbd>Enter</kbd> Zoom
              <kbd>Back</kbd> {infoOpen ? 'Close info' : 'Close'}
            </>
          )}
        </span>
      </footer>
    </div>
  );
}
