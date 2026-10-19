/**
 * input.js — shared remote-key constants and predicates.
 *
 * Both of these were copy-pasted into several files (useKeyHandler,
 * SettingsPanel, PerformerDetailPage, and the nav bar's own Back handler).
 * The copies had already drifted: PerformerDetailPage's version returned
 * early for *any* key while focus was in a text field, which swallowed
 * Escape and the hardware Back key and left the user stuck on the page.
 *
 * Deliberately small — it holds only what more than one module actually
 * needs. The per-direction arrow keyCodes are still written inline at
 * their call sites, and the copies there are not identical: VideoPlayer
 * also handles Tizen's 412/417 for left/right, while useKeyHandler
 * handles only 37/39. Folding those into shared constants would silently
 * change which keys drive spatial nav, so that stays a deliberate,
 * separately-testable change rather than something this module assumes.
 */

/** Hardware Back on a Samsung remote (as delivered to JS by hwkey-event). */
export const TIZEN_BACK = 10009;

/**
 * The nearest ancestor that confines D-pad navigation, or null.
 *
 * Two things confine it: a modal overlay (`role="dialog"`) and an open
 * dropdown marked `data-focus-trap`. A dropdown's options are a closed set, so
 * stepping past the last one must not land on the grid behind the list — which
 * is what happened, because the cross-zone penalty in useKeyHandler only
 * *reorders* candidates. It never excludes them, so when nothing sits ahead in
 * the same zone the search happily takes a candidate from another one.
 *
 * The trap has to cover the trigger as well as the list, or Up from the first
 * option would find nothing and strand the user in the list.
 *
 * Nearest wins, so a dropdown inside a dialog scopes to the dropdown.
 *
 * Two modules need this answer for different reasons: `useKeyHandler` scopes
 * its candidate search with it, and `VideoPlayer` decides whether to yield a
 * key at all by comparing the result against its own overlay element. That
 * second use is why it lives here rather than staying private to the hook — a
 * second, subtly different copy of "what counts as a dialog" is exactly the
 * drift this module exists to prevent.
 *
 * Note the consequence of starting at `el` and stopping at `body`: for an
 * element outside every dialog this returns null, and it returns null for
 * `body` itself. Callers depend on that — null is "no confinement", not
 * "unknown".
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
 * True when focus is in something that consumes text input.
 *
 * Use this only to decide whether a *character* key (Backspace, arrows for
 * the caret) belongs to the field. It must never gate Escape or TIZEN_BACK:
 * those have no text-editing meaning and are the user's only way out.
 * `button`/`submit`/`checkbox`/`radio`/`range` inputs are excluded because
 * they are not text fields despite the INPUT tag.
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
 * `isBackKey` below treats Backspace as Back when no text field has focus.
 * Some layers are stricter on purpose: the filter builder's dialogs predate
 * that rule and never closed on Backspace, so adding a shared hook must not
 * quietly give them a new way to close. Pass this as `useBackKey`'s `isBack`.
 */
export function isHardBackKey(e) {
  return e.key === 'Escape' || e.keyCode === TIZEN_BACK;
}

/**
 * The Back keys, with Backspace belonging to a text field when one has focus.
 *
 * Escape and the hardware Back key always count: they have no text-editing
 * meaning, and if a text field swallowed them the user would be trapped with
 * the IME open. Backspace is the keyboard's delete key *and* the Tizen
 * keyboard's backwards move, so it is Back only where nothing is being typed.
 *
 * Call sites that need a different rule (a modal that swallows every
 * Backspace, a layer that yields to a nested one) pass their own predicate to
 * `useBackKey` rather than editing this one.
 */
export function isBackKey(e) {
  if (e.key === 'Escape' || e.keyCode === TIZEN_BACK) return true;
  if (e.key === 'Backspace') return !isTextInput(document.activeElement);
  return false;
}
