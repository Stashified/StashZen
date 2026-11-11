/**
 * input.js: shared remote-key constants and predicates.
 *
 * Deliberately small, only what more than one module needs. The per-direction
 * arrow keyCodes stay inline: copies there are not identical (VideoPlayer also
 * handles Tizen's 412/417 for left/right, useKeyHandler only 37/39), and
 * folding them into constants would silently change spatial nav, so that stays
 * a separate, testable change.
 *
 * `isTextInput` exists because a copy returned early for *any* key while focus
 * was in a text field, swallowing Escape and hardware Back and trapping the
 * user.
 */

import { claimArrowSwallow, isRestorePending } from './restorePending.js';

/** Hardware Back on a Samsung remote (as delivered to JS by hwkey-event). */
export const TIZEN_BACK = 10009;
/** Back as some remotes send it: a raw key code, not Tizen's constant. */
export const TIZEN_BACK_ALT = 413;

/** Either Back code. Every Back predicate must use this, not just 10009. */
export const isBackCode = (code) => code === TIZEN_BACK || code === TIZEN_BACK_ALT;

/**
 * Arrow presses, for *guards* (the restore's keyboard hold), not for direction
 * mapping. Only the codes useKeyHandler navigates: Tizen's 412/417 are the
 * player's own left/right, and the player is a dialog, where this guard yields.
 */
const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const ARROW_KEY_CODES = new Set([37, 38, 39, 40]);
const isArrowKey = (e) => ARROW_KEYS.has(e.key) || ARROW_KEY_CODES.has(e.keyCode);

// One verdict per event: focus.js (settle) and useKeyHandler (navigate) both
// ask, and the first ask may spend the restore's free swallow.
const verdicts = new WeakMap();

/**
 * An arrow pressed while a restore owns the empty-focus window: the press has
 * nowhere to move from yet, so the immediate one must neither move focus nor
 * settle the restore. Shared by focus.js and useKeyHandler so the two halves
 * cannot drift into a dead key.
 *
 * One free press per restore: Back then one quick press is the case this
 * exists for, but a second fresh press is the user asking to move now, so the
 * restore settles instead of leaving the remote inert. Held-key repeats are
 * the same press and stay swallowed. The hold itself gives up after a few
 * seconds, and Back, Escape and Enter are not arrows and still cancel.
 */
export function isRestoreArrowHold(e) {
  const decided = verdicts.get(e);
  if (decided !== undefined) return decided;

  const ae = document.activeElement;
  let hold = false;
  // A dialog can be up while focus sits on <body> (the player blurs its closed
  // rail there), so it must yield. An open dropdown trap holds focus itself,
  // which the test above already catches.
  if (!(ae && ae !== document.body) && isArrowKey(e)
      && isRestorePending() && !dialogOpen()) {
    hold = e.repeat || claimArrowSwallow();
  }
  verdicts.set(e, hold);
  return hold;
}

/**
 * The nearest ancestor that confines D-pad navigation, or null.
 *
 * Two things confine it: a modal overlay (`role="dialog"`) and an open dropdown
 * marked `data-focus-trap`. A dropdown's options are a closed set, so stepping
 * past the last must not land on the grid behind, the cross-zone penalty in
 * useKeyHandler only *reorders* candidates, never excludes them. The trap must
 * cover the trigger as well as the list, or Up from the first option strands
 * the user.
 *
 * Nearest wins, so a dropdown inside a dialog scopes to the dropdown.
 *
 * Both `useKeyHandler` (candidate search) and `VideoPlayer` (whether to yield a
 * key) need this, and a second "what counts as a dialog" copy is the drift this
 * module prevents. It starts at `el` and stops before `body`, so it returns
 * null outside every dialog, null means "no confinement", not "unknown".
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
 * Is this element actually on screen?
 *
 * `getClientRects().length > 0`, not `offsetParent`: a position:fixed element
 * has no offsetParent, and the viewer overlay is fixed. Both reject
 * display:none and detached nodes; only this accepts fixed positioning.
 */
export function isRendered(el) {
  return el.getClientRects().length > 0;
}

/**
 * Newest rendered match, or null. Rendered first, so a layer still mounted but
 * hidden is not mistaken for the one on top.
 */
export function lastRenderedLayer(selector) {
  const layers = document.querySelectorAll(selector);
  for (let i = layers.length - 1; i >= 0; i--) {
    if (isRendered(layers[i])) return layers[i];
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
 * Anything with a rendered `role="dialog"` is above a page. `data-focus-trap`
 * dropdowns are excluded, a layer inside the page, not a modal over it, and
 * they take focus, which the caller checks with `focusScopeOf`.
 */
export function dialogOpen() {
  return lastRenderedLayer('[role="dialog"]') !== null;
}

/**
 * True when focus is in something that consumes text input.
 *
 * Use this only to decide whether a *character* key (Backspace, caret arrows)
 * belongs to the field. It must never gate Escape or TIZEN_BACK: those have no
 * text-editing meaning and are the user's only way out. `button`/`submit`/
 * `checkbox`/`radio`/`range` inputs are excluded, not text fields despite the
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
 * Escape and the hardware Back key only, Backspace is never Back here.
 *
 * Some layers are stricter on purpose: the filter builder's dialogs predate the
 * Backspace rule and never closed on it, so a shared hook must not quietly give
 * them a new way to close. Pass this as `useBackKey`'s `isBack`.
 */
export function isHardBackKey(e) {
  return e.key === 'Escape' || isBackCode(e.keyCode);
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
  if (e.key === 'Escape' || isBackCode(e.keyCode)) return true;
  if (e.key === 'Backspace') return !isTextInput(document.activeElement);
  return false;
}
