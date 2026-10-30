/**
 * useFocusable: attach to any element to make it TV-navigable
 *
 * Zones group elements for D-pad navigation: within a zone Left/Right/Up/Down
 * move freely, while crossing zones happens via Up/Down only, which prevents
 * Left/Right leaking out of horizontal rows.
 *
 * Usage:
 *   const { ref, focused } = useFocusable({ id: 'my-btn', zone: 'grid' });
 *
 * ## Long press
 *
 * Opt-in: pass `onLongPress` and the element distinguishes a tap from a hold;
 * elements without it are untouched and `onEnter` still fires on keydown. The
 * short action necessarily moves to keyup (~80–150 ms), the price of one press
 * meaning both "play" and "open the menu". Moving focus cancels the press:
 * blur kills the timer.
 *
 * `onEnter` receives the keydown event, so a surface with focusable children
 * can tell its own Enter from one bubbling up from a child.
 */

import { useRef, useState, useEffect, useCallback, useId } from 'react';
import { isRestorePending } from '../utils/restorePending.js';
import { scrollContainerOf } from '../utils/scroll.js';

const registry = new Map();
let currentFocusId = null;
// The element that is mid-`focus()` from an `autoFocusFallback` timer; read by
// `handleFocus` to record how focus got there, see `autoFocusWhenIdle`.
let focusingFallback = false;

// How long Enter must be held for a long-pressable element to count it as a
// hold rather than a tap. Below this it is a tap; above it the menu opens.
export const LONG_PRESS_MS = 600;

// Two elements this close vertically are on the same line for the top-row
// reset. The focused card's 1.05 scale and 4px lift move its own rect up by
// about 12px, so the tolerance covers that; a row pitch is hundreds of pixels.
const FIRST_ROW_PX = 24;

// Read by useKeyHandler (candidate search) and VideoCarousel.
export { registry };
export function getCurrentFocusId() { return currentFocusId; }

export function useFocusable({
  id: propId,
  zone = null,
  group = null,          // legacy alias for `zone`
  onFocus,
  onBlur,
  onEnter,
  onLongPress,           // opt-in: see "Long press" above
  longPressMs = LONG_PRESS_MS,
  disabled = false,
  autoFocus = false,
  // Opt-in, only with `autoFocus`. Takes focus only when nothing else has it
  // (`activeElement` is <body>), for the *first card of a listing*, not for
  // dialogs: a listing reset unmounts every card, and the new first card would
  // otherwise pull the ring out of the search field (closing the TV keyboard)
  // or off the controls trigger just used. Dialogs keep the aggressive default.
  autoFocusWhenIdle = false,
  // Opt-in, only with `autoFocus`: a *fallback*, it takes focus only if
  // nothing else has it, and unlike any other focus may be replaced later by
  // an `autoFocusWhenIdle` element.
  //
  // The rail is the case: it exists on every tab and claims focus at boot, but
  // a shelf card mounts after its fetch and is the intended resting place. A
  // focus the *user* placed, a D-pad press or a dialog, is never replaced.
  autoFocusFallback = false,
  // Opt-in: this element can never be *entered* by Left/Right. Used by the
  // rail's inactive rows, which sit in the grid's own zone; without it Left
  // out of the content lands on whichever row is beside the card (Settings,
  // low down) instead of the tab being looked at. Entering is the axis worth
  // gating, see useKeyHandler.
  verticalOnly = false,
  // Opt-in: one row of the left navigation rail. The rows sit in the grid's
  // own zone, so Down out of the last card of a page finds Settings when the
  // next page has not arrived. Down skips rail rows from the content; Up may
  // still enter them, because returning from the top row is intended.
  railRow = false,
  // Opt-in: connected across zones while still refusing to be entered sideways
  // from outside its own, that refusal is why it has a zone. The controls bar
  // keeps a zone so the grid cannot step in sideways, then must be lifted out
  // of both penalties: CROSS_ZONE_PENALTY (Up would land on the rail instead of
  // the filter below) and the same-zone requirement (Left would do nothing).
  // See useKeyHandler.
  crossZone = false,
  // Opt-in: an explicit destination for a direction, e.g. `{ down: 'nav-x' }`,
  // replacing the spatial search for that press (falling back to it if the
  // named element is missing or disabled).
  //
  // For a layout the scoring cannot see through: the rail's rows use it, since
  // Settings sits at the bottom while the tabs sit at the top, and the empty
  // middle loses to the nearest grid card (score ~434 against ~860, at a 1.5
  // secondary weight), so every Down left the rail. Being also `verticalOnly`,
  // that made Settings unreachable. The rail knows its own order; geometry does
  // not. A general ordered-list mode would cost more than one declared edge.
  nextId = null,
} = {}) {
  const generatedId = useId();
  const id = propId || generatedId;
  const ref = useRef(null);
  const [focused, setFocused] = useState(false);

  const effectiveZone = zone ?? group;

  const callbacksRef = useRef({ onFocus, onBlur, onEnter, onLongPress, longPressMs });
  useEffect(() => {
    callbacksRef.current = { onFocus, onBlur, onEnter, onLongPress, longPressMs };
  });

  const autoFocusedRef = useRef(false);
  const nextIdRef = useRef(nextId);

  // Refreshed every render, not in the registration effect below: callers write
  // `nextId={{ down: 'nav-settings' }}`, a fresh object each render, and putting
  // it in that effect's deps would tear down and re-add four listeners per
  // render, felt in the D-pad on a TV. The ref lets the registration effect
  // read the value without depending on it; on the first commit this effect
  // runs first and finds no entry, so a ref is the only way to avoid installing
  // a stale `nextId` until the next render.
  useEffect(() => {
    nextIdRef.current = nextId;
    const entry = registry.get(id);
    if (entry) entry.nextId = nextId;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!disabled && !el.getAttribute('tabindex')) {
      el.setAttribute('tabindex', '0');
    }

    const handleFocus = () => {
      setFocused(true);
      currentFocusId = id;
      // Recorded per focus, not per element: the same rail row is a *fallback*
      // at boot and a user-placed stop later, and only the former may be
      // replaced. See `autoFocusWhenIdle`.
      const entry = registry.get(id);
      if (entry) entry.focusOrigin = focusingFallback ? 'fallback' : 'user';
      callbacksRef.current.onFocus?.();
      // Keep the focused card in view; `nearest` scrolls only when out of view.
      //
      // `behavior: 'auto'` is explicit: it overrides CSS `scroll-behavior` so a
      // stylesheet cannot silently restore the glide. Smooth scrolling was
      // measured as a drag on the TV, it animates on the main thread, so each
      // press started an animation competing with the next, and the ring
      // trailed the key. Grid wrappers set `scroll-behavior` too; both stay
      // instant.
      if (el.scrollIntoView) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }

      // The top row goes back to the listing's opening position. Walking up
      // one row at a time leaves the container a little scrolled once the top
      // row is already on screen, since nothing scrolls when it does not have
      // to, and that residual clips the focused card's scale and lift at the
      // top. Only the top row is corrected: the rows below have no opening
      // position to return to.
      const scroller = scrollContainerOf(el);
      if (scroller && scroller.scrollTop > 0) {
        // The first tab stop in the container is in its top row by definition.
        const first = scroller.querySelector('[tabindex="0"]');
        if (first && (first === el
          || Math.abs(first.getBoundingClientRect().top - el.getBoundingClientRect().top)
            < FIRST_ROW_PX)) {
          scroller.scrollTop = 0;
        }
      }

      // A card is not the whole shelf. On Home the focusable sits under a row
      // heading, and scrolling only the card left the heading 42px above the
      // fold, clipping the card's focus scale and -4px lift. When a showroom
      // row is clipped at the top, scroll the row instead, and for the first
      // row go to the page's top padding.
      //
      // Only the top edge: Down into a row stays minimal, since the heading is
      // already visible above the card.
      const row = el.closest?.('[data-showroom-row]');
      if (row && row.getBoundingClientRect().top < 0) {
        row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        if (!row.previousElementSibling) row.parentElement.scrollTop = 0;
      }
    };

    // ── Press tracking ───────────────────────────────────────
    // Only used by long-pressable elements. `pressTimer` is non-null while
    // the key is down and the hold has not yet been recognised; the flag
    // records that it *was* recognised, so the keyup knows to swallow the
    // short action instead of firing it.
    let pressTimer = null;
    let longPressFired = false;

    const cancelPress = () => {
      clearTimeout(pressTimer);
      pressTimer = null;
      longPressFired = false;
    };

    const isEnterKey = (e) => e.key === 'Enter' || e.keyCode === 13;

    const handleBlur = () => {
      // The movement cancellation: a D-pad press moves focus, focus fires
      // blur here, and the hold dies with it.
      cancelPress();
      setFocused(false);
      callbacksRef.current.onBlur?.();
    };

    const handleKeyDown = (e) => {
      if (!isEnterKey(e)) return;

      const { onEnter, onLongPress: longPress, longPressMs: holdMs } = callbacksRef.current;

      // Auto-repeat is never an activation. A remote spams keydown at ~30 Hz,
      // so repeats would run the action 30 times a second, and outlive the
      // first press: a long press moves focus into the menu it opened, and
      // every repeat activates its first row, so holding OK plays the scene
      // instead of showing the menu. Only a fresh keydown after a keyup counts.
      if (e.repeat) {
        e.preventDefault();
        return;
      }

      if (!longPress) {
        onEnter?.(e);
        e.preventDefault();
        return;
      }

      // Suppress native activation: a focused <button> would fire a click on
      // keydown and run the action twice, from onEnter and onClick.
      e.preventDefault();

      // A held remote repeats keydown at ~30 Hz. The timer belongs to the
      // first press and must be left alone to run.
      if (e.repeat || pressTimer !== null || longPressFired) return;

      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressFired = true;
        longPress();
      }, holdMs);
    };

    const handleKeyUp = (e) => {
      if (!isEnterKey(e)) return;
      if (!callbacksRef.current.onLongPress) return;
      e.preventDefault();

      // The hold already fired; this keyup is its tail, not a tap.
      if (longPressFired) { cancelPress(); return; }

      // No timer means no keydown reached us (or it was already consumed).
      const wasDown = pressTimer !== null;
      cancelPress();
      if (wasDown) callbacksRef.current.onEnter?.(e);
    };

    // A hold that spans the app going to the background is not a hold the
    // user is still performing, and on Tizen the keyup may never arrive.
    const cancelOnHide = () => cancelPress();
    document.addEventListener('visibilitychange', cancelOnHide);
    window.addEventListener('pagehide', cancelOnHide);

    el.addEventListener('focus', handleFocus);
    el.addEventListener('blur', handleBlur);
    el.addEventListener('keydown', handleKeyDown);
    el.addEventListener('keyup', handleKeyUp);

    // `nextIdRef.current`, not `nextId`: reading the prop here would make it a
    // dependency, and a fresh object each render would re-register the element
    // every time. See the refresh effect above.
    registry.set(id, {
      el, zone: effectiveZone, verticalOnly, crossZone, railRow, nextId: nextIdRef.current,
    });


    // The 50 ms lets the element land in the DOM before asking for focus. The
    // latch keeps this once-per-instance, so a dep change cannot yank focus
    // back from where the user navigated.
    let autoFocusTimer = null;
    let autoFocusFired = false;
    // A restore is on its way to a card here: hold first-card focus so the
    // cursor does not land on the wrong one and then jump. The cap still
    // leaves the D-pad somewhere to move after 1.5 s.
    const autoFocusDeferUntil = Date.now() + 1500;
    if (!disabled && autoFocus && !autoFocusedRef.current) {
      autoFocusedRef.current = true;
      const runAutoFocus = () => {
        autoFocusFired = true;
        if (autoFocusFallback) {
          if (document.activeElement && document.activeElement !== document.body) return;
        }
        if (autoFocusWhenIdle) {
          const ae = document.activeElement;
          if (ae && ae !== document.body) {
            // A fallback focus, the rail's boot-time claim, is not the user
            // being somewhere. Anything else is, and is left alone.
            const currentEntry = currentFocusId ? registry.get(currentFocusId) : null;
            const replaceable = currentEntry?.el === ae && currentEntry.focusOrigin === 'fallback';
            if (!replaceable) return;
          }
          if (isRestorePending() && Date.now() < autoFocusDeferUntil) {
            autoFocusTimer = setTimeout(runAutoFocus, 200);
            return;
          }
        }
        focusingFallback = autoFocusFallback;
        el.focus();
        focusingFallback = false;
      };
      autoFocusTimer = setTimeout(runAutoFocus, 50);
    }

    return () => {
      cancelPress();
      document.removeEventListener('visibilitychange', cancelOnHide);
      window.removeEventListener('pagehide', cancelOnHide);
      clearTimeout(autoFocusTimer);
      // If the timer was cancelled before it fired, release the latch so the
      // re-run still can. Under StrictMode (dev) the effect mounts, cleans up
      // and runs again; without this the second run sees the latch set and the
      // element stays focusable but never focused, stranding the D-pad.
      if (autoFocusTimer !== null && !autoFocusFired) {
        autoFocusedRef.current = false;
      }
      el.removeEventListener('focus', handleFocus);
      el.removeEventListener('blur', handleBlur);
      el.removeEventListener('keydown', handleKeyDown);
      el.removeEventListener('keyup', handleKeyUp);
      if (registry.get(id)?.el === el) registry.delete(id);
      // Forget where focus was only when the element is gone. A
      // *re-registration* (`disabled` flipping, `verticalOnly` following the
      // tab) leaves it connected, and nulling this started the next Left/Right
      // from <body> with no zone. The entry is re-added below, even while
      // disabled, since the candidate search already skips it as a landing
      // target, so the current element keeps its zone and rect.
      if (currentFocusId === id && !el.isConnected) currentFocusId = null;
    };
  }, [id, effectiveZone, disabled, autoFocus, autoFocusWhenIdle, autoFocusFallback,
    verticalOnly, crossZone, railRow]);

  const focus = useCallback(() => {
    ref.current?.focus();
  }, []);

  return { ref, focused, focus, id };
}
