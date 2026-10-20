/**
 * useKeyHandler — global D-pad key handler with zone-aware spatial nav
 *
 * Performance: rects are cached per-element and invalidated only on
 * scroll/resize. Without caching, each arrow press would call
 * getBoundingClientRect() 40+ times — a known cause of D-pad lag on
 * weak TV CPUs (Tizen).
 *
 * Held-key navigation is throttled to MIN_REPEAT_MS so spatial nav
 * doesn't get spammed by 30Hz key-repeat from the remote.
 *
 * While navigating, document.body gets the `is-navigating` class. It is a
 * JS signal, not a styling hook: VideoCard and MarkerCard check it before
 * starting a preview, so that holding an arrow doesn't spawn a preview
 * player for every card the focus passes over. There are deliberately no
 * CSS rules keyed on it — see the note in index.css for why the ones that
 * used to exist were themselves a per-keypress cost.
 */

import { useEffect, useRef } from 'react';
import { registry, getCurrentFocusId } from './useFocusable.js';
import { TIZEN_BACK, isTextInput, focusScopeOf } from '../utils/input.js';

const CROSS_ZONE_PENALTY = 100000;
// Larger than the zone penalty: a same-container candidate must beat a
// cross-zone one even when the latter is much nearer. See scrollContainerOf.
const CONTAINER_EXIT_PENALTY = 1000000;
const MIN_REPEAT_MS = 90;          // throttle held arrows to ~11 Hz
const NAV_CLASS_RELEASE_MS = 180;  // when keys idle this long, drop is-navigating

// ── Rect cache ───────────────────────────────────────────
// Rects are cached per element and the map is swapped out on scroll/resize
// and at the start of every keypress. Within one keypress we may measure
// many candidates; measuring each only once is what keeps D-pad movement
// responsive on a TV CPU, where getBoundingClientRect on 40+ nodes shows up.
const rectCacheRef = { current: new WeakMap() };

function getCachedRect(el) {
  let r = rectCacheRef.current.get(el);
  if (!r) {
    r = el.getBoundingClientRect();
    rectCacheRef.current.set(el, r);
  }
  return r;
}

/**
 * Is this element actually on screen?
 *
 * `getClientRects().length > 0` rather than `offsetParent`: a position:fixed
 * element has NO offsetParent, and the full-screen viewer overlay is fixed —
 * so an `offsetParent` test makes a registered fixed focusable invisible to
 * geometry. Both checks reject `display:none` and detached nodes; only this
 * one also accepts fixed positioning. Used everywhere the handler decides
 * whether a registry entry is reachable, so the forced-edge path and the
 * geometric search cannot disagree about it (the 0.29.0 harness run found
 * exactly that disagreement).
 */
function isRendered(el) {
  return el.getClientRects().length > 0;
}

/**
 * The nearest ancestor the element actually scrolls inside, or null.
 *
 * Geometry alone treats a scrolled-out row and the fixed footer below it as
 * equally valid destinations, and the footer wins whenever it is nearer — so
 * Down in a long dialog skips whatever is still below the fold and jumps
 * straight to Save. Reported from the TV, 2026-10-17: "it jumps to save when
 * not scrolled down (resumes scrolling when I keep pressing down)".
 *
 * Requiring actual overflow (scrollHeight > clientHeight) rather than merely
 * `overflow-y: auto` keeps the penalty off containers that have nothing to
 * scroll right now, where the geometry is already the whole story.
 */
function scrollContainerOf(el) {
  let n = el?.parentElement;
  while (n && n !== document.body && n !== document.documentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    n = n.parentElement;
  }
  return null;
}

/**
 * The nearest ancestor laid out as a *wrapped* flex row, or null.
 *
 * A wrapped row is one logical line of content rendered as several physical
 * lines, so it reads left-to-right, top-to-bottom. Right at the end of such a
 * row must continue on the next physical line, not dead-end. That is what the
 * scene detail's action row needs: Play / rating / Organised / o-count on the
 * first line, then Clear progress / Mark played / Back, and the second line
 * starts to the *left* of where the first one ends — so plain geometry finds
 * nothing to the right at all.
 *
 * Grids are `display: grid` and deliberately excluded: there, Right stops at
 * the end of the row, which is the usual TV-grid behaviour.
 */
function wrapContainerOf(el) {
  let n = el?.parentElement;
  while (n && n !== document.body && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'flex' && (cs.flexWrap === 'wrap' || cs.flexWrap === 'wrap-reverse')) {
      return n;
    }
    n = n.parentElement;
  }
  return null;
}

function findBestCandidate(direction, currentEl, currentEntry) {
  const isHorizontal = direction === 'left' || direction === 'right';
  const currentZone = currentEntry?.zone ?? null;

  // An explicit destination, when the layout defeats the scoring below.
  //
  // It is checked before any geometry because that is the whole point of it:
  // the case it exists for — the rail's Settings row, 860px below the tabs
  // with a grid card halfway — is one where the geometry gives a confidently
  // wrong answer. See `nextId` in useFocusable for the numbers.
  //
  // Falls through to the search rather than swallowing the keypress if the
  // named element is gone from the DOM or is a disabled control, since a
  // declared edge that can dead-end the D-pad would be a worse trap than the
  // one this fixes.
  const forcedId = currentEntry?.nextId?.[direction];
  if (forcedId) {
    const forced = registry.get(forcedId);
    // A self-reference is how a direction is *blocked*: it resolves, so the
    // geometry is never consulted, and focusing the element that already has
    // focus moves nothing. The rail's Settings row uses it — Down there must
    // not fall into the grid, and Right is the only way out. Reported from
    // the TV, 2026-10-17: "it should stay there unless pressed right".
    if (forced?.el === currentEl) return null;
    // `isRendered` rather than `offsetParent`: a position:fixed element has
    // NO offsetParent, and the full-screen viewer overlay is fixed — so the
    // Info button's declared Down edge silently fell through to geometry and
    // dead-ended on the picture (found by the 0.29.0 harness run). The rect
    // check still rejects display:none and detached nodes.
    if (forced?.el && isRendered(forced.el) && !forced.el.disabled) {
      return forced.el;
    }
  }

  // Two opt-in flags shape the edges around the rail and the controls bar.
  // They are the two halves of one idea — "the bar is joined to the grid" —
  // split by which side of the move each has to be read from.
  //
  //  - `verticalOnly` (candidate-side) shuts a horizontal edge for good. The
  //    rail's inactive rows use it. They need it because they sit in the
  //    grid's own zone, where the zone guard below cannot help: Left out of a
  //    card would otherwise land on whichever row is beside it, and for cards
  //    low enough down that row is Settings, so a sideways press opened a
  //    modal.
  //  - `crossZone` (both sides) says this element is joined to the rest of the
  //    app across zones. The controls bar uses it, because a zone of its own
  //    is what stops the grid entering it sideways and also, by itself, what
  //    stops the bar leaving. Read off the mover, it waives the same-zone
  //    requirement; read off the candidate, it waives CROSS_ZONE_PENALTY, so
  //    Up out of the first card row lands on the filter below rather than on
  //    the rail row above.
  const currentCrossesZones = currentEntry?.crossZone === true;
  // Up/Down prefer to stay inside the scroll container already in use, so a
  // long body is walked to its end before focus can reach a fixed footer.
  // Left/Right are untouched — a horizontal strip is its own thing.
  const currentScroll = isHorizontal ? null : scrollContainerOf(currentEl);
  // Only a wrapped row gets the reading-order treatment below; a grid keeps
  // its row edges. See wrapContainerOf.
  const wrapContainer = isHorizontal ? wrapContainerOf(currentEl) : null;
  const curRect = getCachedRect(currentEl);
  const curCx = curRect.left + curRect.width / 2;
  const curCy = curRect.top + curRect.height / 2;

  // Active focus scope — when set, candidates outside it are excluded.
  // Falls back to any open dialog in the DOM if the user is currently
  // focused on something outside the modal (e.g. body) but a modal is
  // visible. This handles the moment a modal opens before its first
  // autoFocus has fired. An open dropdown is consulted second so the
  // dialog fallback keeps behaving exactly as it did before traps existed.
  let scope = focusScopeOf(currentEl);
  if (!scope) {
    scope = document.querySelector('[role="dialog"]')
         || document.querySelector('[data-focus-trap]');
  }

  let bestEl = null;
  let bestScore = Infinity;

  // The rail is not underneath the content. Its rows share the grid's zone (see
  // NavRail), so Down out of the last loaded card found Settings — fixed at the
  // foot of the screen — whenever the next page was still in flight. Holding
  // Down through a page load therefore dropped the cursor into the sidebar.
  // Reported from the TV, 2026-10-18: "When scrolling tab content (scenes
  // performers etc) with remote quickly, the focus changes to settings
  // (sidebar) during new page/items load. Should stay focused on content."
  //
  // Down only, and only out of the content: inside the rail the Down chain is
  // declared (see NavRail's ITEMS) and checked before this loop, and Up into
  // the rail from the top card row is a route the user asked for (H11).
  const skipRailRows = direction === 'down' && currentEntry?.railRow !== true;

  registry.forEach(({ el, zone, verticalOnly, crossZone, railRow }) => {
    if (el === currentEl || !isRendered(el)) return;
    // A DOM-disabled element cannot take focus — `.focus()` on one is a
    // silent no-op — so leaving it in the candidate set makes it an
    // absorbing wall: every press finds it, the browser refuses it, and
    // focus never moves off whatever the user was already on. That is what
    // made the detail page's action row a dead end, because the rating
    // stepper's "−" is disabled while a scene is unrated and it sits
    // immediately right of Play.
    //
    // `useFocusable` has its own `disabled` option that keeps an element out
    // of the registry entirely, but that is a promise each call site has to
    // keep and several render `disabled` on the button without passing it to
    // the hook. Reading the element cannot drift from what the user sees.
    // Deliberately not checking `aria-disabled`: that marks a control as
    // inert but leaves it focusable by design, so it does not create the wall.
    if (el.disabled) return;
    // See the flag notes at the top of this function.
    if (isHorizontal && verticalOnly) return;
    if (railRow && skipRailRows) return;
    if (isHorizontal && zone !== currentZone && !currentCrossesZones) return;
    if (scope && !scope.contains(el)) return;

    const rect = getCachedRect(el);
    const dx = (rect.left + rect.width / 2) - curCx;
    const dy = (rect.top + rect.height / 2) - curCy;

    // Inside a wrapped row, a sideways press belongs to its physical line.
    // Anything on another line is handled by the wrap pass after the loop, in
    // reading order (leftmost of the next line first), which is something the
    // centre-based scoring below cannot express.
    //
    // An element *outside* the container is treated in one of two ways, and
    // the distinction is geometric rather than by component name:
    //
    //  - Wholly beyond the container's edge in the direction of travel — the
    //    rail, left of the controls bar — is a legitimate neighbour and is
    //    scored normally. Making the container a hard boundary for everyone
    //    turned the bar into a sideways trap (R7 in rail-entry.jsx caught it).
    //  - Overlapping the container's horizontal span but sitting on another
    //    line — the marker-chip row above the scene detail's actions — is a
    //    line change by another name, and is excluded. Allowing those made
    //    Right out of the actions' last control jump to the third chip
    //    (T13's sixth press), and Left out of that chip jump back into the
    //    actions in the middle rather than at its right edge (T15).
    //
    // The comparison is against the container's box, not the current
    // element's, because the current element may be anywhere along its line.
    if (wrapContainer) {
      if (wrapContainer.contains(el)) {
        if (!(rect.top < curRect.bottom - 2 && rect.bottom > curRect.top + 2)) return;
      } else {
        const wrapRect = getCachedRect(wrapContainer);
        const beyondEdge = direction === 'left'
          ? rect.right <= wrapRect.left + 2
          : rect.left >= wrapRect.right - 2;
        if (!beyondEdge) return;
      }
    }

    let primary, secondary;
    switch (direction) {
      case 'up':    if (dy >= -4) return; primary = -dy; secondary = dx < 0 ? -dx : dx; break;
      case 'down':  if (dy <=  4) return; primary =  dy; secondary = dx < 0 ? -dx : dx; break;
      case 'left':  if (dx >= -4) return; primary = -dx; secondary = dy < 0 ? -dy : dy; break;
      case 'right': if (dx <=  4) return; primary =  dx; secondary = dy < 0 ? -dy : dy; break;
      default: return;
    }

    let score = primary + secondary * 1.5;
    if (!isHorizontal && zone !== currentZone && !crossZone) score += CROSS_ZONE_PENALTY;
    if (currentScroll && !currentScroll.contains(el)) score += CONTAINER_EXIT_PENALTY;

    if (score < bestScore) { bestScore = score; bestEl = el; }
  });

  // End of a wrapped physical line: continue at the start of the next one.
  // "Next" is decided by the line's edge, then by position within that line —
  // plain reading order, which the directional scoring above cannot produce
  // because the next line starts *behind* the current element. Left is the
  // same rule in reverse: it enters the previous line at its right edge.
  if (!bestEl && isHorizontal && wrapContainer) {
    const goingRight = direction === 'right';
    let bestKey = Infinity;
    registry.forEach(({ el, zone, verticalOnly }) => {
      if (el === currentEl || !isRendered(el) || el.disabled) return;
      if (verticalOnly) return;
      if (zone !== currentZone && !currentCrossesZones) return;
      if (scope && !scope.contains(el)) return;
      if (!wrapContainer.contains(el)) return;
      const rect = getCachedRect(el);
      const gap = goingRight ? rect.top - curRect.bottom : curRect.top - rect.bottom;
      // The chosen line must lie wholly beyond the current one. The 2 px
      // allowance mirrors the overlap test above, which the focus scale skews.
      if (gap < -2) return;
      // Line-major, then column-major. The multiplier only has to beat the
      // widest possible screen coordinate on this row.
      const cx = rect.left + rect.width / 2;
      const key = gap * 10000 + (goingRight ? cx : -cx);
      if (key < bestKey) { bestKey = key; bestEl = el; }
    });
  }

  return bestEl;
}

export function useKeyHandler({ onBack } = {}) {
  // App passes a fresh closure every render. Holding it in a ref keeps the
  // handler current while letting the effect below run exactly once —
  // otherwise every App render tore down and re-added the keydown/resize/
  // scroll listeners, and dropped `is-navigating` mid-burst.
  const onBackRef = useRef(onBack);
  useEffect(() => { onBackRef.current = onBack; });

  useEffect(() => {
    let lastNavAt = 0;
    let navClassTimer = null;

    const setNavigating = () => {
      document.body.classList.add('is-navigating');
      clearTimeout(navClassTimer);
      navClassTimer = setTimeout(
        () => document.body.classList.remove('is-navigating'),
        NAV_CLASS_RELEASE_MS,
      );
    };

    const handleKeyDown = (e) => {
      const key = e.key;
      let direction = null;
      if (key === 'ArrowUp'    || e.keyCode === 38) direction = 'up';
      if (key === 'ArrowDown'  || e.keyCode === 40) direction = 'down';
      if (key === 'ArrowLeft'  || e.keyCode === 37) direction = 'left';
      if (key === 'ArrowRight' || e.keyCode === 39) direction = 'right';

      if (direction) {
        // When focus is in a text field, Left/Right belong to the caret
        // (move within the value). Up/Down don't position the caret in a
        // single-line input — the browser's default is "jump to start/
        // end of value", which traps the user. So we still run spatial
        // nav for Up/Down on inputs, just not for Left/Right.
        const ae = document.activeElement;
        const inText = isTextInput(ae);
        const isHorizontal = direction === 'left' || direction === 'right';
        if (inText && isHorizontal) return;

        // For TEXTAREA specifically, Up/Down do move the caret between
        // lines, so respect those too. Single-line INPUT doesn't have rows.
        if (inText && ae.tagName === 'TEXTAREA') return;

        e.preventDefault();

        // Throttle held-key repeats — TV remotes spam keydown ~30 Hz.
        const now = performance.now();
        if (now - lastNavAt < MIN_REPEAT_MS) return;
        lastNavAt = now;
        setNavigating();

        // Invalidate cached rects on every keypress. The cache helps for
        // multiple lookups within a single keypress, but between keypresses
        // CSS transitions and layout-affecting re-renders can change positions
        // without triggering scroll/resize events. Clearing per-press costs
        // very little (one Map allocation) and prevents stale-rect bugs.
        rectCacheRef.current = new WeakMap();

        const currentId = getCurrentFocusId();
        const currentEntry = currentId ? registry.get(currentId) : null;
        const currentEl = currentEntry?.el || document.activeElement;

        if (currentEl && registry.size > 0) {
          const best = findBestCandidate(direction, currentEl, currentEntry);
          if (best) best.focus();
        } else {
          for (const { el } of registry.values()) {
            // Disabled elements stay registered (so the current one keeps its
            // zone while it is disabled — see useFocusable's cleanup), but
            // `.focus()` on one is a silent no-op, which would leave the user
            // on <body>. Skip them here exactly as the candidate search does.
            if (isRendered(el) && !el.disabled) { el.focus(); break; }
          }
        }
        return;
      }

      if (key === 'Backspace' || e.keyCode === TIZEN_BACK) {
        // The on-screen keyboard's delete button sends Backspace. Don't
        // interpret that as the global Back action while a text field
        // has focus — let the browser delete the character normally.
        // Tizen Back (10009) still triggers onBack regardless, since it's
        // a hardware key with no text-editing meaning.
        if (key === 'Backspace' && isTextInput(document.activeElement)) return;
        onBackRef.current?.();
      }
    };

    // Geometry changes — drop cached rects.
    const invalidate = () => { rectCacheRef.current = new WeakMap(); };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', invalidate);
    window.addEventListener('scroll', invalidate, true); // capture: catches scroll on inner containers too

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('scroll', invalidate, true);
      clearTimeout(navClassTimer);
      document.body.classList.remove('is-navigating');
    };
  }, []);
}