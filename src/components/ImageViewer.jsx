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
 * ## What it cannot do
 *
 * It steps through the listing it was handed — the array the grid had loaded at
 * the moment the image was opened — and stops at either end rather than paging
 * in more. The grid keeps loading behind it, but the snapshot does not grow.
 * Paging from inside the viewer is a real feature and not a small one: it needs
 * the grid's own `fetchPage`, which lives in `usePagedList` two components
 * down. Worth doing when the viewer has shown it needs to.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { TIZEN_BACK } from '../utils/input.js';
import { fetchImageInfo } from '../utils/imageService.js';
import { buildImageInfoRows } from '../utils/imageInfo.js';
import styles from './ImageViewer.module.css';

export default function ImageViewer({ items = [], index = 0, onClose, onIndexChange }) {
  const [imgError, setImgError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // The info panel is read-only. It is a header button rather than a key on
  // the surface because the viewer is opened by Enter, and binding Enter to
  // the surface would let that press's auto-repeats toggle the panel.
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoStatus, setInfoStatus] = useState('idle'); // idle | loading | ready | error
  const [infoData, setInfoData] = useState(null);
  const [infoMessage, setInfoMessage] = useState('');
  const currentIdRef = useRef(null);

  const { ref } = useFocusable({
    id: 'image-viewer',
    zone: 'image-viewer',
    autoFocus: true,
    nextId: { up: 'image-viewer-info' },
  });
  const infoBtn = useFocusable({
    id: 'image-viewer-info',
    zone: 'image-viewer',
    nextId: { down: 'image-viewer' },
    // `onEnter`, not just `onClick`: useFocusable prevents the native button
    // activation on Enter (see its longPress branch), so a button that only
    // carries `onClick` never fires from the remote. Same convention as
    // tvActions.ActionButton. `closeInfo` is defined below — the arrow body
    // runs on a key event, long after the render that created it.
    onEnter: () => (infoOpen ? closeInfo() : setInfoOpen(true)),
  });

  const item = items[index] || null;
  const canPrev = index > 0;
  const canNext = index < items.length - 1;

  // Reset the per-image state whenever the picture changes, or the second
  // image inherits the first one's failure and shows the fallback.
  useEffect(() => { setImgError(false); setLoaded(false); }, [item?.id]);

  // Stepping races the info request: the answer for image 5 can land after
  // the viewer is already on image 6. The ref is what the resolve checks.
  useEffect(() => { currentIdRef.current = item?.id ?? null; }, [item?.id]);

  // Fetch only while the panel is open — stepping through a listing with the
  // panel closed must not issue one request per image.
  useEffect(() => {
    if (!infoOpen || !item?.id) return undefined;
    let cancelled = false;
    const requestedId = item.id;
    setInfoStatus('loading');
    setInfoMessage('');
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
    return () => { cancelled = true; };
  }, [infoOpen, item]);

  const closeInfo = useCallback(() => {
    setInfoOpen(false);
    ref.current?.focus();
  }, [ref]);

  useEffect(() => {
    const handler = (e) => {
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
        onIndexChange?.(index - 1);
      } else if (e.key === 'ArrowRight' && canNext) {
        e.preventDefault();
        e.stopPropagation();
        onIndexChange?.(index + 1);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [index, canPrev, canNext, onClose, onIndexChange, infoOpen, closeInfo, ref]);

  if (!item) return null;

  // `full` is the full-resolution file and `image_path` the thumbnail; the
  // service puts both through withApiKey. Falling back to the thumbnail is for
  // a row whose `paths.image` came back empty, which does happen — a file Stash
  // knows about but cannot serve still has a thumbnail route.
  const src = item.full || item.image_path;
  // Never draw the previous image's metadata under the new one while the
  // next request is in flight.
  const infoRows = infoData && infoData.id === item.id ? buildImageInfoRows(infoData) : [];

  return (
    <div
      ref={ref}
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={item.title || 'Image'}
      tabIndex={-1}
    >
      <div className={styles.stage}>
        {src && !imgError ? (
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
        )}

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
        <h2 className={styles.title}>{item.title}</h2>
        <div className={styles.meta}>
          {item.date && <span>{item.date}</span>}
          {item.rating && <span className={styles.rating}>★ {item.rating}</span>}
        </div>
        <button
          ref={infoBtn.ref}
          className={`${styles.infoBtn} ${infoBtn.focused ? styles.infoBtnFocused : ''}`}
          onClick={() => (infoOpen ? closeInfo() : setInfoOpen(true))}
          aria-pressed={infoOpen}
        >
          Info
        </button>
      </header>

      <footer className={styles.footer}>
        {/* The position is against what this viewer was handed, which can be
            fewer than the listing's total — the grid had loaded 40 of 31,251
            when the card was pressed. Saying "12 / 40" here would read as a
            claim about the library, so it says "of 40 loaded" instead. */}
        <span className={styles.counter}>
          {index + 1} <span className={styles.counterSep}>of</span> {items.length} loaded
        </span>
        <span className={styles.hint}>
          <kbd>▲</kbd> Info
          {canPrev || canNext ? <><kbd>◀</kbd> <kbd>▶</kbd> Browse</> : null}
          <kbd>Back</kbd> Close
        </span>
      </footer>
    </div>
  );
}
