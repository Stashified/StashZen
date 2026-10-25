/**
 * input.js — shared remote-key constants and predicates.
 *
 * Deliberately small — only what more than one module needs. The per-direction
 * arrow keyCodes stay inline: copies there are not identical (VideoPlayer also
 * handles Tizen's 412/417 for left/right, useKeyHandler only 37/39), and
 * folding them into constants would silently change spatial nav, so that stays
 * a separate, testable change.
 *
 * `isTextInput` exists because a copy returned early for *any* key while focus
 * was in a text field, swallowing Escape and hardware Back and trapping the
 * user.
 */

/** Hardware Back on a Samsung remote (as delivered to JS by hwkey-event). */
export const TIZEN_BACK = 10009;

/**
 * The nearest ancestor that confines D-pad navigation, or null.
 *
 * Two things confine it: a modal overlay (`role="dialog"`) and an open dropdown
 * marked `data-focus-trap`. A dropdown's options are a closed set, so stepping
 * past the last must not land on the grid behind — the cross-zone penalty in
 * useKeyHandler only *reorders* candidates, never excludes them. The trap must
 * cover the trigger as well as the list, or Up from the first option strands
 * the user.
 *
 * Nearest wins, so a dropdown inside a dialog scopes to the dropdown.
 *
 * Both `useKeyHandler` (candidate search) and `VideoPlayer` (whether to yield a
 * key) need this, and a second "what counts as a dialog" copy is the drift this
 * module prevents. It starts at `el` and stops before `body`, so it returns
 * null outside every dialog — null means "no confinement", not "unknown".
 */
export function focusScopeOf(el) {
  let n = el;
  while (n && n !== document.body) {
    if (n.getAttribute) {
      if (n.getAttribute('role') === 'dialog') return n;
      if (n.hasAttribute('data-focus-trap')) return n;
    }
    n = n.parentElement;
  }
  return null;
}

/**
 * True when any modal layer is open, wherever focus is.
 *
 * `focusScopeOf` answers "what confines focus"; this asks "is a modal layer up
 * at all". The player is where they differ: when its rail closes it blurs to
 * <body> on purpose, so a page-level Back guard asking only where focus is saw
 * nothing, closed the page underneath, and left the user on the listing when
 * the player's Back then closed it.
 *
 * Presence is the right test for a page: anything with `role="dialog"` is above
 * it. `data-focus-trap` dropdowns are excluded — a layer inside the page, not a
 * modal over it, and they take focus, which the caller checks with
 * `focusScopeOf`.
 */
export function dialogOpen() {
  return document.querySelector('[role="dialog"]') !== null;
}

/**
 * True when focus is in something that consumes text input.
 *
 * Use this only to decide whether a *character* key (Backspace, caret arrows)
 * belongs to the field. It must never gate Escape or TIZEN_BACK: those have no
 * text-editing meaning and are the user's only way out. `button`/`submit`/
 * `checkbox`/`radio`/`range` inputs are excluded — not text fields despite the
 * INPUT tag.
 */
export function isTextInput(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return !['button', 'submit', 'checkbox', 'radio', 'range'].includes(el.type);
}

/**
 * Escape and the hardware Back key only — Backspace is never Back here.
 *
 * Some layers are stricter on purpose: the filter builder's dialogs predate the
 * Backspace rule and never closed on it, so a shared hook must not quietly give
 * them a new way to close. Pass this as `useBackKey`'s `isBack`.
 */
export function isHardBackKey(e) {
  return e.key === 'Escape' || e.keyCode === TIZEN_BACK;
}

/**
 * The Back keys, with Backspace belonging to a text field when one has focus.
 *
 * Escape and hardware Back always count: no text-editing meaning, and if a text
 * field swallowed them the user would be trapped with the IME open. Backspace
 * is the keyboard's delete key *and* the Tizen keyboard's backwards move, so it
 * is Back only where nothing is being typed.
 *
 * Call sites needing a different rule pass their own predicate to `useBackKey`
 * rather than editing this one.
 */
export function isBackKey(e) {
  if (e.key === 'Escape' || e.keyCode === TIZEN_BACK) return true;
  if (e.key === 'Backspace') return !isTextInput(document.activeElement);
  return false;
}
