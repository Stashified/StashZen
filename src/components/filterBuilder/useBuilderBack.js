import { useEffect, useRef } from 'react';
import { TIZEN_BACK, isTextInput, focusScopeOf } from '../../utils/input.js';

/**
 * FilterBuilder's Back guard — THE GUARD IS LOAD-BEARING, and the reason is
 * ordering rather than taste.
 *
 * Every layer here listens for Back on `window` in the capture phase, and
 * capture listeners on the same target run in *registration* order. The
 * builder mounts before any picker opens, so its listener is registered first
 * and therefore runs first — a Back inside an open picker reaches this handler
 * before the picker's own. `stopPropagation` does not help: it suppresses the
 * rest of the propagation path, not a sibling listener on the same target,
 * which only `stopImmediatePropagation` would. Without this guard one Back
 * closes the picker *and* the builder behind it.
 *
 * Call it at the same point in the component it was written at: before the
 * focusables, and never behind a condition. Re-registering on each change
 * would move this listener to the end of the order, which is the opposite of
 * what is wanted and would make the bug intermittent.
 *
 * `open` must mirror what is actually rendered, deliberately down to the
 * `picking && pickingDesc?.entity` check at the call site. `picking` alone is
 * not enough: a multi-valued criterion with no entity source renders no
 * picker at all, so a guard armed on `picking` alone would stand Back down
 * with nothing on screen — a dead Back button, reached by clicking a button
 * that appears to do nothing. No shipped tab has such a field today (the
 * three that do are File and Folder, which nothing builds filters for); that
 * is a reason to keep the conditions identical rather than a reason to skip
 * the check.
 *
 * The `open` snapshot goes through a ref rather than the dependency list, so
 * the listener is registered once per `onClose`. A ref written in an effect,
 * not during render: a render-phase ref write is not safe under a discarded
 * or replayed render, and there is nothing to gain — the value is only ever
 * read from a key event, which is always after commit.
 *
 * Returns the ref for the builder's own dialog element. The guard uses it to
 * tell "focus is in this builder" from "focus is in something layered over
 * it": the overlay flag can lag by a commit, the DOM cannot. The same guard
 * also covers the layers that are not tracked by the flag — most importantly
 * an open Choice menu, whose `data-focus-trap` closes on its own Back
 * handler. Without it, Back closed the dropdown *and* the builder.
 */
export function useBuilderBack({ open, onClose }) {
  const overlayOpenRef = useRef(false);

  useEffect(() => {
    overlayOpenRef.current = open;
  });

  const rootRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (overlayOpenRef.current) return;   // a nested layer owns Back right now
      const scope = focusScopeOf(document.activeElement);
      if (scope && scope !== rootRef.current) return;
      if (e.key === 'Escape' || e.keyCode === TIZEN_BACK
        || (e.key === 'Backspace' && !isTextInput(document.activeElement))) {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  return rootRef;
}
