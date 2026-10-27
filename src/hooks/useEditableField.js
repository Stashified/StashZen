/**
 * useEditableField: a text field the D-pad selects before it can be typed in
 *
 * Focusing an editable <input> raises the TV keyboard, so focus lands on a
 * *wrapper* element instead and moves onto the real <input> only on Enter. The
 * <input> must carry `tabIndex={-1}`: that guarantees this hook is the only
 * thing that can focus it, and the keyboard opens only when intended.
 *
 * While merely selected, `document.activeElement` is the wrapper, so
 * isTextInput() is false and Left/Right navigate instead of being swallowed by
 * the caret, and Backspace means Back. While editing it is a real input and
 * behaves as before; that predicate is shared by three Back escapes, so it
 * must not change.
 *
 * Usage:
 *   const { setWrapperRef, inputRef, selected, editing, inputHandlers } =
 *     useEditableField({ id: 'ctrl-search', zone: 'grid', onCommit });
 *
 *   <div ref={setWrapperRef} className={selected ? styles.focused : ''}>
 *     <input ref={inputRef} tabIndex={-1} {...inputHandlers} />
 *   </div>
 *
 * Put `...inputHandlers` on the input and the ref on the wrapper. Two traps:
 *
 *  1. Never pass `onBlur` to useFocusable: it binds `blur` on the wrapper, and
 *     focusing the input blurs the wrapper, clearing `editing` the instant the
 *     field is activated, the keyboard is up, but the ring and hint still say
 *     "selected". `editing` is driven only by the input's own onBlur.
 *
 *  2. useFocusable binds a NATIVE keydown listener on the wrapper, and React
 *     delegates its handlers to the root container, so the wrapper's listener
 *     runs first on Enter bubbling from the input and `stopPropagation` cannot
 *     suppress it. Hence the exact activeElement comparison in `onEnter`, which
 *     keeps the two states separable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable } from './useFocusable.js';

export function useEditableField({
  id,
  zone = null,
  onCommit,
  externalRef,
  // Forwarded verbatim to useFocusable: this hook builds its own call, so an
  // option not named here is silently dropped, the bug that put Right from
  // the Home row on the search box. `autoFocus` is for the first-run screen,
  // which has no navigation above it to arrive from.
  verticalOnly = false,
  crossZone = false,
  autoFocus = false,
  // Same forwarding rule; the filter builder's criterion rows need it, or
  // Left falls back to the geometry.
  nextId = null,
} = {}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef(null);

  // Held in a ref so the handler below stays current without re-registering.
  const commitRef = useRef(onCommit);
  useEffect(() => { commitRef.current = onCommit; });

  const { ref, focused } = useFocusable({
    id,
    zone,
    verticalOnly,
    crossZone,
    autoFocus,
    nextId,
    onEnter: () => {
      // Trap 2: only Enter on the wrapper itself activates; one bubbled from
      // the input belongs to the input's handler, which finishes editing.
      if (document.activeElement !== ref.current) return;
      setEditing(true);
    },
  });

  // Merged so callers can hand the wrapper elsewhere, SettingsPanel lands
  // focus on the URL field when the user flips to Live. The *wrapper*, so the
  // keyboard does not open.
  const setWrapperRef = useCallback((el) => {
    ref.current = el;
    if (typeof externalRef === 'function') externalRef(el);
    else if (externalRef) externalRef.current = el;
  }, [ref, externalRef]);

  // Focus after the render that set `editing`. This call is the one that
  // raises the keyboard.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const finishEdit = useCallback(() => {
    setEditing(false);
    // Focus back explicitly, merely blurring leaves focus on <body>, with
    // nothing for the D-pad to navigate from.
    ref.current?.focus();
  }, [ref]);

  const inputHandlers = {
    onKeyDown: (e) => {
      if (e.key !== 'Enter') return;
      commitRef.current?.();
      finishEdit();
    },
    onBlur: () => {
      // Trap 1: this, not useFocusable's onBlur, owns `editing`.
      setEditing(false);
      // The IME's Done/close blurs the input; if nothing claimed focus, put it
      // back on the wrapper, but leave it if a nav target already took it
      // (stealing it back would undo the user's move).
      setTimeout(() => {
        const ae = document.activeElement;
        if (!ae || ae === document.body) ref.current?.focus();
      }, 0);
    },
  };

  // `focused` is false while editing (the wrapper has blurred), so styling
  // keys off this.
  return { setWrapperRef, inputRef, selected: focused || editing, editing, finishEdit, inputHandlers };
}
