import { useCallback, useRef } from 'react';

/**
 * Remember an element and put focus back on it after the thing that took
 * focus away has unmounted.
 *
 * The delay is load-bearing: an overlay close unmounts its DOM and the browser
 * then settles focus, so focusing in the same tick drops the cursor to <body>,
 * where no D-pad press can move it. The element is checked with
 * `document.contains` when the timer fires because the card can be pruned
 * while its overlay is still open; `fallback` focuses something else rather
 * than stranding the cursor.
 */
export function useRestoreFocus() {
  const targetRef = useRef(null);

  const remember = useCallback((el) => {
    targetRef.current = el;
  }, []);

  const restore = useCallback(({ delay = 50, fallback } = {}) => {
    setTimeout(() => {
      const el = targetRef.current;
      if (el && document.contains(el)) {
        el.focus();
        return;
      }
      fallback?.();
    }, delay);
  }, []);

  return { targetRef, remember, restore };
}
