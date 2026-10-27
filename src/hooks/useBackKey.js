import { useEffect, useRef } from 'react';
import { isBackKey } from '../utils/input.js';

/**
 * Register a Back/Escape handler on `window` during the capture phase.
 *
 * Capture is the point: the global handler in `useKeyHandler` is bubble-phase,
 * so a layer that owns Back must run first or the global handler would switch
 * tabs before it could close.
 *
 * The handler is held in a ref and the effect registers once: on the shared
 * `window` target, listener order is registration order, and pages depend on
 * running before an overlay registered later. Re-registering every render
 * would move this listener to the end of that list.
 *
 * `preventDefault`/`stopPropagation` run before the handler. Note that
 * `stopPropagation` does not suppress a *sibling* listener on the same target
 * (only `stopImmediatePropagation` would), so a layer that must yield to a
 * nested one checks for it inside its own handler, see the `pinFlowRef` and
 * `focusScopeOf` guards at the call sites.
 *
 * `isBack` should be stable (the default is); an inline predicate re-registers
 * the listener on every render.
 */
export function useBackKey(onBack, {
  capture = true,
  enabled = true,
  isBack = isBackKey,
  preventDefault = true,
  stopPropagation = true,
} = {}) {
  const handlerRef = useRef(onBack);
  useEffect(() => { handlerRef.current = onBack; });

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (!isBack(e)) return;
      if (preventDefault) e.preventDefault();
      if (stopPropagation) e.stopPropagation();
      // A held Back repeats, and each repeat reaches whichever layer is on top
      // by then, one press could close the layer that owned it and every one
      // behind it. Only the first keydown is the press; it is still swallowed
      // above.
      if (e.repeat) return;
      handlerRef.current?.(e);
    };
    window.addEventListener('keydown', onKey, capture);
    return () => window.removeEventListener('keydown', onKey, capture);
  }, [capture, enabled, isBack, preventDefault, stopPropagation]);
}
