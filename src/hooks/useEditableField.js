/**
 * useEditableField — a text field the D-pad selects before it can be typed in
 *
 * Navigating onto a text field used to raise the TV's on-screen keyboard
 * immediately, because focusing an editable <input> is what raises it. This
 * hook makes focus land on a *wrapper* element instead, and only moves it
 * onto the real <input> when the user presses Enter. The keyboard then
 * appears on a focus change we made on purpose.
 *
 * The <input> must carry `tabIndex={-1}`. That is not decoration: it is what
 * guarantees this hook is the only thing that can ever focus the input, and
 * therefore that the keyboard opens only when we mean it to.
 *
 * While merely selected, `document.activeElement` is the wrapper, so
 * isTextInput() (utils/input.js) is false and Left/Right navigate instead of
 * being swallowed by the caret; Backspace means Back. While editing the
 * active element is a real editable input and everything behaves as it
 * always did. No change to that predicate is needed — which matters, since
 * it is shared by three separate Back escapes.
 *
 * Usage:
 *   const { setWrapperRef, inputRef, selected, editing, inputHandlers } =
 *     useEditableField({ id: 'ctrl-search', zone: 'grid', onCommit });
 *
 *   <div ref={setWrapperRef} className={selected ? styles.focused : ''}>
 *     <input ref={inputRef} tabIndex={-1} {...inputHandlers} />
 *   </div>
 *
 * Both the wrapper and the input are real, so put `...inputHandlers` on the
 * input and the ref on the wrapper.
 *
 * Two traps this file exists to hold in one place:
 *
 *  1. Never pass `onBlur` to useFocusable for these fields. It binds `blur`
 *     on the wrapper, and moving focus to the input blurs the wrapper — so
 *     its handler fires and clears `editing` the instant the field is
 *     activated. The field still ends up with focus, so it looks half-right
 *     while being wrong: the keyboard is up, but the ring is the quiet
 *     "selected" one and the hint still says "Press Enter to edit".
 *     `editing` is driven only by the input's own onBlur, below. Verified by
 *     control experiment.
 *
 *  2. useFocusable binds a NATIVE keydown listener on the wrapper, and React
 *     delegates its own handlers to the root container — so the wrapper's
 *     listener runs first on Enter bubbling up from the input, and
 *     `stopPropagation` in a React handler cannot suppress it. Hence the
 *     activeElement comparison in `onEnter`: an exact test, not a heuristic.
 *     Today both call sites finish editing on that Enter anyway, which masks
 *     the difference; the guard is what keeps the two states separable, so
 *     an input that ever handles Enter some other way (a textarea inserting
 *     a newline, say) cannot be re-activated from underneath.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable } from './useFocusable.js';

export function useEditableField({
  id,
  zone = null,
  onCommit,
  externalRef,
  // Forwarded verbatim to useFocusable. It has to be declared here to exist:
  // this hook builds its own useFocusable call, so an option the caller passes
  // and this signature does not name is simply dropped — which is what
  // happened to the search field and the rail driver caught, by finding Right
  // from the Home row landing on the search box instead of on a card.
  // `autoFocus` joined the list for the first-run screen, which has no
  // navigation above it to arrive from: without it the D-pad starts on <body>
  // and the screen is not reachable at all.
  verticalOnly = false,
  crossZone = false,
  autoFocus = false,
  // Same forwarding rule as the three above. The filter builder needs it:
  // a text value inside a criterion row has to join that row's declared
  // left/right chain, and without it the search box problem returns — the
  // caller names an edge, this hook drops it, and Left falls back to the
  // geometry.
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
      // Trap 2: if the wrapper is the focused element, Enter was pressed on
      // it. If it isn't, the key bubbled up from the input and belongs to
      // the input's own handler, which is what finishes editing.
      if (document.activeElement !== ref.current) return;
      setEditing(true);
    },
  });

  // Merged for callers that need to hand the wrapper to something else —
  // SettingsPanel does, to land focus on the URL field when the user flips
  // to Live mode. Note it is the *wrapper* they get: the point is "select
  // this field", not "raise the keyboard on it".
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
    // Hand focus back explicitly rather than merely blurring the input —
    // otherwise the ring disappears and focus lands on <body>, leaving the
    // D-pad with nothing to navigate from.
    ref.current?.focus();
  }, [ref]);

  const inputHandlers = {
    onKeyDown: (e) => {
      if (e.key !== 'Enter') return;
      commitRef.current?.();
      finishEdit();
    },
    onBlur: () => {
      // Trap 1: this — not useFocusable's onBlur — owns `editing`.
      setEditing(false);
      // The IME's own Done/close blurs the input. If nothing claimed focus,
      // put it back on the wrapper; if a nav target already took it, leave
      // it, since stealing it back would undo the move the user just made.
      setTimeout(() => {
        const ae = document.activeElement;
        if (!ae || ae === document.body) ref.current?.focus();
      }, 0);
    },
  };

  // Styling keys off this rather than `focused`: while editing, the wrapper
  // has blurred (focus moved to its descendant, which is what the keyboard
  // is tracking) and useFocusable reports focused === false.
  return { setWrapperRef, inputRef, selected: focused || editing, editing, finishEdit, inputHandlers };
}
