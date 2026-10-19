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

import { useEffect, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { TIZEN_BACK } from '../utils/input.js';
import styles from './ImageViewer.module.css';

export default function ImageViewer({ items = [], index = 0, onClose, onIndexChange }) {
  const [imgError, setImgError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const { ref } = useFocusable({
    id: 'image-viewer',
    zone: 'image-viewer',
    autoFocus: true,
  });

  const item = items[index] || null;
  const canPrev = index > 0;
  const canNext = index < items.length - 1;

  // Reset the per-image state whenever the picture changes, or the second
  // image inherits the first one's failure and shows the fallback.
  useEffect(() => { setImgError(false); setLoaded(false); }, [item?.id]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || e.keyCode === TIZEN_BACK) {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
        return;
      }
      // ArrowLeft/ArrowRight only — not the TV's channel keys. Stepping is a
      // browse gesture and the arrows are what the rest of the app uses for it.
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
  }, [index, canPrev, canNext, onClose, onIndexChange]);

  if (!item) return null;

  // `full` is the full-resolution file and `image_path` the thumbnail; the
  // service puts both through withApiKey. Falling back to the thumbnail is for
  // a row whose `paths.image` came back empty, which does happen — a file Stash
  // knows about but cannot serve still has a thumbnail route.
  const src = item.full || item.image_path;

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
      </div>

      <header className={styles.bar}>
        <h2 className={styles.title}>{item.title}</h2>
        <div className={styles.meta}>
          {item.date && <span>{item.date}</span>}
          {item.rating && <span className={styles.rating}>★ {item.rating}</span>}
        </div>
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
          {canPrev || canNext ? <><kbd>◀</kbd> <kbd>▶</kbd> Browse</> : null}
          <kbd>Back</kbd> Close
        </span>
      </footer>
    </div>
  );
}
