import { useCallback, useRef } from 'react';

/**
 * Remember an element and put focus back on it after the thing that took
 * focus away has unmounted.
 *
 * The delay is not stylistic. An overlay close unmounts its DOM and then the
 * browser settles focus around that removal; focusing an element in the same
 * tick drops the cursor to <body>, where no D-pad press can move it. The app
 * has used 50 ms at every overlay close; callers that remove the competing
 * element synchronously can pass a shorter delay.
 *
 * The remembered element is checked against the document when the timer
 * fires, not when it is remembered, because the card can be pruned while the
 * overlay it opened is still up (Continue Watching drops a scene whose
 * progress was cleared). `fallback` is the caller's answer to that — focus
 * something else rather than strand the cursor.
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
