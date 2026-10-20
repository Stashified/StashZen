/**
 * useFocusable — attach to any element to make it TV-navigable
 *
 * Zones group elements for D-pad navigation:
 *   - Within a zone, Left/Right/Up/Down move freely.
 *   - Crossing zones happens via Up/Down only (typical TV pattern).
 *   - This prevents Left/Right from "leaking" out of horizontal rows.
 *
 * Usage:
 *   const { ref, focused } = useFocusable({
 *     id: 'my-btn',
 *     zone: 'grid',
 *   });
 *
 * ## Long press
 *
 * Opt-in: pass `onLongPress` and the element distinguishes a tap from a
 * hold. Elements that don't pass it are untouched — `onEnter` still fires
 * on keydown, exactly as before, so nothing that exists today can regress.
 *
 * The short action of a long-pressable element necessarily moves from
 * keydown to keyup (~80–150 ms on a typical remote). That delay is the
 * price of the feature: a single press cannot otherwise mean both "play"
 * and "open the menu" without one of them firing first.
 *
 * Movement cancels the press for free: any D-pad key moves focus, focus
 * fires `blur` on this element, and the timer dies with it. The keyup that
 * follows lands on whatever took focus, not here.
 */

import { useRef, useState, useEffect, useCallback, useId } from 'react';
import { isRestorePending } from '../utils/restorePending.js';

const registry = new Map();
let currentFocusId = null;
// The element that is mid-`focus()` from an `autoFocusFallback` timer. Read by
// `handleFocus` to record how the focused element got there — see
// `autoFocusWhenIdle` for why the distinction matters.
let focusingFallback = false;

// How long Enter must be held for a long-pressable element to count it as a
// hold rather than a tap. Below this it is a tap; above it the menu opens.
export const LONG_PRESS_MS = 600;

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
  // Opt-in, and only meaningful with `autoFocus`. Takes focus only when
  // nothing else has it, i.e. `document.activeElement` is <body>.
  //
  // This is for the *first card of a listing*, not for dialogs. A listing
  // resets — a search keystroke, a sort, a filter — and unmounts every card;
  // the new first card then auto-focuses and pulls the focus ring out of the
  // search field (closing the TV keyboard) or off the controls trigger the
  // user just used. Dialogs must keep the aggressive default: they open from
  // a focused control and exist to take focus from it.
  autoFocusWhenIdle = false,
  // Opt-in, and only meaningful with `autoFocus`: this element is a *fallback*
  // — it takes focus only if nothing else has it, and unlike any other focus
  // it may be replaced by an `autoFocusWhenIdle` element later.
  //
  // The rail is the case. It is the one focus stop that exists on every tab,
  // including the frames before a listing's first card has loaded, so it
  // claims focus at boot. The tab's content is the intended resting place,
  // though, and a shelf card mounts only after its fetch resolves — by then
  // the rail has held focus for a while. Treating that as "the user is
  // somewhere" is what left Home resting on the rail; the rail never moved
  // focus, it simply happened first. A focus the *user* placed — a D-pad
  // press, or a dialog opened from one — is still never replaced.
  autoFocusFallback = false,
  // Opt-in: this element can never be *entered* by a Left/Right press. Used by
  // the rail's inactive rows, which sit in the grid's own zone: without it,
  // Left out of the content column lands on whichever row happens to be beside
  // the card — Settings, for cards low enough down — instead of on the tab the
  // user is actually looking at. See useKeyHandler for why *entering* is the
  // axis worth gating, and NavRail for the rule it implements.
  verticalOnly = false,
  // Opt-in: this element is one row of the left navigation rail. The rail is
  // drawn to the left of the content, but its rows sit in the grid's own zone
  // (see NavRail), so Down out of the last card of a page finds a rail row —
  // Settings, at the foot of the screen — whenever the next page has not
  // arrived yet. Holding Down through a page load then dropped the cursor onto
  // the rail. Down now skips rail rows while the cursor is in the content;
  // Up may still enter the rail, because returning there from the top row is
  // intended. See useKeyHandler for the rule.
  railRow = false,
  // Opt-in: this element is connected to the rest of the app *across* zones,
  // while still refusing to be entered sideways from outside its own — that
  // refusal is the whole point of giving it a zone. Used by the controls bar,
  // which keeps a zone of its own so nothing in the grid can step into it
  // sideways, and then has to be lifted out of both penalties that zone
  // imposes: the CROSS_ZONE_PENALTY that would make Up out of the first card
  // row land on the rail row above instead of on the filter below, and the
  // same-zone requirement that would make Left out of the bar do nothing at
  // all. See useKeyHandler for the two rules it appears in, and ControlsPanel.
  crossZone = false,
  // Opt-in: an explicit destination for a direction, e.g. `{ down: 'nav-x' }`.
  // It replaces the spatial search for that one press, falling back to it if
  // the named element is missing or disabled.
  //
  // This is for a layout the scoring cannot see through. The rail's rows use
  // it: Settings is pinned to the bottom of the rail while the three tabs sit
  // at the top, so the 860px of empty rail between them loses to the nearest
  // grid card (score ~434 against ~860, at a 1.5 secondary weight) and every
  // Down press left the rail. Since Settings is also `verticalOnly`, that made
  // it unreachable from the remote by any route — reported from the TV on
  // 2026-10-16. The rail knows its own order; the geometry does not.
  //
  // A general "ordered list" mode would be a bigger thing than one edge, and
  // the cost of the explicit edge is only visible where it is declared.
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

  // Refreshed on every render rather than in the registration effect below.
  // Callers write `nextId={{ down: 'nav-settings' }}`, which is a fresh object
  // each render; putting it in that effect's dependency list would tear down
  // and re-add the element's four listeners on every single render, which on a
  // TV is the kind of thing you feel in the D-pad. An effect with no dep array
  // is one Map lookup and one assignment.
  //
  // The ref is what lets the registration effect *below* read the value without
  // taking it as a dependency — and it has to be a ref rather than just relying
  // on this effect, because on the very first commit this one runs first and
  // finds no registry entry to update, so the registration would otherwise
  // install a stale `nextId` and nothing would correct it until the next
  // render. (Refs are also the house answer to this: see `callbacksRef` above,
  // which has the same problem for the same reason.)
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
      // when it claims focus at boot and a user-placed stop once the D-pad
      // reaches it, and only the former may be replaced. See
      // `autoFocusWhenIdle`.
      const entry = registry.get(id);
      if (entry) entry.focusOrigin = focusingFallback ? 'fallback' : 'user';
      callbacksRef.current.onFocus?.();
      // Keep the focused card in view. `block: 'nearest'` only scrolls when
      // the element is actually out of view, rather than constantly
      // re-centering.
      //
      // `behavior: 'auto'` is explicit, not redundant: it overrides the CSS
      // `scroll-behavior` property, so a stylesheet can't silently put the
      // glide back. Smooth scrolling here was measured as a drag on the TV —
      // it animates on the main thread, so every D-pad press started an
      // animation that then competed with the *next* press, and the focus
      // ring visibly trailed the key. Grid wrappers set `scroll-behavior`
      // too; both places have to stay instant.
      if (el.scrollIntoView) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }

      // A card is not the whole shelf. On Home the focusable sits under a
      // row heading, and scrolling only the card is why coming back up from
      // the gallery shelf left the page at scrollTop 70 instead of 0: the
      // heading was 42px above the fold and the focused card's focus scale
      // and -4px lift were clipped at the top edge. Reported from the TV,
      // 2026-10-17. When a showroom row is clipped at the top, scroll the
      // row (heading included) instead, and when it is the first row, go
      // all the way to the page's own top padding.
      //
      // Only the top edge is handled: moving Down into a row should stay as
      // minimal as before, because the row's heading is already above the
      // card and visible.
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

      // Auto-repeat is never an activation. A remote spams keydown at ~30 Hz
      // while a key is held, so acting on repeats runs the action 30 times a
      // second — and worse, the repeats outlive whatever the first press did:
      // a long press moves focus into the menu it just opened, and every
      // repeat that follows lands on the first row and activates it, so
      // holding OK plays the scene instead of showing the menu. Only a fresh
      // keydown, after a keyup, counts as a press.
      if (e.repeat) {
        e.preventDefault();
        return;
      }

      if (!longPress) {
        onEnter?.();
        e.preventDefault();
        return;
      }

      // Always suppress the native activation — a focused <button> would
      // otherwise fire a click on keydown and the action would run twice,
      // once from onEnter and once from onClick.
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
      if (wasDown) callbacksRef.current.onEnter?.();
    };

    // A hold that spans the app going to the background is not a hold the
    // user is still performing — and on Tizen the keyup may never arrive.
    const cancelOnHide = () => cancelPress();
    document.addEventListener('visibilitychange', cancelOnHide);
    window.addEventListener('pagehide', cancelOnHide);

    el.addEventListener('focus', handleFocus);
    el.addEventListener('blur', handleBlur);
    el.addEventListener('keydown', handleKeyDown);
    el.addEventListener('keyup', handleKeyUp);

    // `nextIdRef.current`, not `nextId`: reading the prop here would mean
    // listing it as a dependency, and a fresh object each render would then
    // re-register the element on every one. See the refresh effect above.
    registry.set(id, {
      el, zone: effectiveZone, verticalOnly, crossZone, railRow, nextId: nextIdRef.current,
    });


    // The 50ms delay exists to let the element land in the DOM before
    // asking for focus. The latch keeps this once-per-instance, so a dep
    // change doesn't yank focus back to an element the user has navigated
    // away from.
    let autoFocusTimer = null;
    let autoFocusFired = false;
    // A restore is on its way to a card in this listing: hold the first-card
    // focus so the cursor does not land on the wrong one and then jump. The
    // cap means a restore that finds nothing still leaves the D-pad somewhere
    // to move from rather than on <body> for the whole 8 s budget.
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
            // A fallback focus — the rail's boot-time claim — is not the user
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
      // If the timer was cancelled before it fired, this effect run left
      // nothing focused — release the latch so the re-run still can.
      //
      // This matters under React StrictMode (dev only): it mounts, runs
      // the effect, cleans up, then runs it again. Without this, the
      // cleanup cancels the first timer and the second run sees the latch
      // already set, so the element ends up focusable but never focused —
      // which strands the user's D-pad on <body> until they press a key.
      if (autoFocusTimer !== null && !autoFocusFired) {
        autoFocusedRef.current = false;
      }
      el.removeEventListener('focus', handleFocus);
      el.removeEventListener('blur', handleBlur);
      el.removeEventListener('keydown', handleKeyDown);
      el.removeEventListener('keyup', handleKeyUp);
      if (registry.get(id)?.el === el) registry.delete(id);
      // Forgetting where focus was is only correct when the element is gone.
      // A *re-registration* — `disabled` flipping, the rail's `verticalOnly`
      // following the active tab — leaves it connected and still on screen,
      // and nulling this made the next Left/Right press start from <body>,
      // where there is no zone: every zone-tagged candidate was rejected and
      // the horizontal D-pad did nothing until the user pressed Up or Down.
      //
      // The entry above is deleted and re-added by the new effect run, so a
      // disabled element has no entry again only if the effect body skips
      // registering it. It registers either way (the candidate search already
      // skips `el.disabled` as a landing target), precisely so the *current*
      // element keeps its zone and rect while it is disabled.
      if (currentFocusId === id && !el.isConnected) currentFocusId = null;
    };
  }, [id, effectiveZone, disabled, autoFocus, autoFocusWhenIdle, autoFocusFallback,
    verticalOnly, crossZone, railRow]);

  const focus = useCallback(() => {
    ref.current?.focus();
  }, []);

  return { ref, focused, focus, id };
}
