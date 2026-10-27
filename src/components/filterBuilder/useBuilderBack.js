import { useEffect, useRef } from 'react';
import { isBackCode, isTextInput, focusScopeOf } from '../../utils/input.js';

/**
 * FilterBuilder's Back guard. Load-bearing, and for ordering reasons.
 *
 * Every layer listens for Back on `window` in the capture phase, and siblings
 * on one target run in registration order. The builder mounts first, so its
 * handler runs first, without this guard one Back closes the picker *and* the
 * builder. `stopPropagation` cannot help; only `stopImmediatePropagation`
 * would suppress a sibling.
 *
 * Call it before the focusables and never behind a condition: re-registering
 * would move the listener to the end and make the bug intermittent. `open` and
 * `onClose` go through refs (written in an effect) for the same reason, and
 * `open` must mirror what is rendered down to `pickingDesc?.entity`, or Back
 * stands down with nothing on screen. No shipped tab has such a field today,
 * but the conditions should stay identical.
 *
 * The returned ref lets the guard tell "focus is in this builder" from "focus
 * is in a layer over it", the DOM does not lag a commit the way a flag can.
 * It also covers the Choice menu, which closes on its own Back handler.
 */
export function useBuilderBack({ open, onClose }) {
  const overlayOpenRef = useRef(false);

  useEffect(() => {
    overlayOpenRef.current = open;
  });

  const rootRef = useRef(null);

  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const handler = (e) => {
      if (overlayOpenRef.current) return;   // a nested layer owns Back right now
      const scope = focusScopeOf(document.activeElement);
      if (scope && scope !== rootRef.current) return;
      if (e.key === 'Escape' || isBackCode(e.keyCode)
        || (e.key === 'Backspace' && !isTextInput(document.activeElement))) {
        // A held Back is one press; repeats must not close what a nested
        // layer opened after the first one (see useBackKey).
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  return rootRef;
}
