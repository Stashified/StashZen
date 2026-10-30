/**
 * useKeyHandler: global D-pad key handler with zone-aware spatial nav
 *
 * Rects are cached per element and invalidated on scroll/resize and per press;
 * without that, one arrow press measures 40+ nodes and the D-pad lags on a TV
 * CPU. Held keys are throttled to MIN_REPEAT_MS because the remote repeats at
 * ~30 Hz.
 *
 * While navigating, `document.body` carries `is-navigating`. It is a JS signal,
 * not a styling hook: VideoCard and MarkerCard check it so holding an arrow
 * does not spawn a preview for every card passed over. No CSS is keyed on it:
 * see index.css for why those rules were themselves a per-press cost.
 */

import { useEffect, useRef } from 'react';
import { registry, getCurrentFocusId } from './useFocusable.js';
import { isBackCode, isTextInput, focusScopeOf } from '../utils/input.js';
import { scrollContainerOf } from '../utils/scroll.js';

const CROSS_ZONE_PENALTY = 100000;
// Larger than the zone penalty: a same-container candidate must beat a
// cross-zone one even when the latter is much nearer. See scrollContainerOf.
const CONTAINER_EXIT_PENALTY = 1000000;
const MIN_REPEAT_MS = 90;          // throttle held arrows to ~11 Hz
// The focus ring lifts a card 4 px (4.2 after the 1.05 scale), so a neighbour
// in the same row measures about 4 px below it. Anything that close is level,
// not in that direction; at a 4 px test Down walked sideways along a
// six-column row instead of reaching the section below.
const LEVEL_TOLERANCE = 8;
// Between the two, a candidate is level, and up/down only takes it across a
// zone boundary: along a row that would be a sideways hop, while the controls
// bar sits level with the rail's top row and is the way in from there.
const LEVEL_FALLBACK = 4;
const NAV_CLASS_RELEASE_MS = 180;  // when keys idle this long, drop is-navigating

// ── Rect cache ───────────────────────────────────────────
// One WeakMap swapped out on scroll/resize and per keypress, so a candidate
// seen twice in one press is measured once.
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
 * `getClientRects().length > 0`, not `offsetParent`: a position:fixed element
 * has no offsetParent, and the viewer overlay is fixed. Both reject
 * display:none and detached nodes; only this accepts fixed positioning. Every
 * reachability check goes through here so the forced-edge path and the
 * geometric search cannot disagree.
 */
function isRendered(el) {
  return el.getClientRects().length > 0;
}

/**
 * The nearest ancestor laid out as a *wrapped* flex row, or null.
 *
 * A wrapped row is one logical line rendered as several physical ones, read
 * left-to-right then top-to-bottom: Right at the end must continue on the next
 * line, which may start left of where it ended, geometry finds nothing there.
 * Grids are excluded, so their Right stops at the row end as usual.
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

  // An explicit destination, checked before geometry because that is the point:
  // for the rail's Settings row, 860 px below the tabs with a card halfway, the
  // geometry is confidently wrong. Falls through if the named element is gone
  // or disabled, a declared edge must not dead-end the D-pad.
  const forcedId = currentEntry?.nextId?.[direction];
  if (forcedId) {
    const forced = registry.get(forcedId);
    // A self-reference *blocks* a direction: it resolves, so geometry is never
    // consulted, and focusing the focused element moves nothing. The rail's
    // Settings row uses it so Down cannot fall into the grid.
    if (forced?.el === currentEl) return null;
    // `isRendered` rather than `offsetParent`: the viewer overlay is fixed and
    // has no offsetParent, which made a declared edge fall through to geometry
    // and dead-end on the picture.
    if (forced?.el && isRendered(forced.el) && !forced.el.disabled) {
      return forced.el;
    }
  }

  // Two opt-in flags shape the edges around the rail and the controls bar,
  // split by which side of the move each is read from.
  //
  //  - `verticalOnly` (candidate-side) shuts a horizontal edge. The rail's
  //    inactive rows sit in the grid's own zone, so the zone guard cannot help:
  //    Left out of a low card would land on Settings and open a modal.
  //  - `crossZone` (both sides) says the element is joined across zones. On the
  //    mover it waives the same-zone rule; on the candidate it waives
  //    CROSS_ZONE_PENALTY, so Up from the first card row reaches the filter
  //    below rather than the rail row above.
  const currentCrossesZones = currentEntry?.crossZone === true;
  // Up/Down prefer to stay inside the scroll container already in use, so a
  // long body is walked to its end before focus can reach a fixed footer.
  // Left/Right are untouched, a horizontal strip is its own thing.
  const currentScroll = isHorizontal ? null : scrollContainerOf(currentEl);
  // Only a wrapped row gets the reading-order treatment below; a grid keeps
  // its row edges. See wrapContainerOf.
  const wrapContainer = isHorizontal ? wrapContainerOf(currentEl) : null;
  const curRect = getCachedRect(currentEl);
  const curCx = curRect.left + curRect.width / 2;
  const curCy = curRect.top + curRect.height / 2;

  // Active focus scope, when set, candidates outside it are excluded.
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
  // A level candidate, kept apart so a real move in the direction always wins.
  // See LEVEL_FALLBACK.
  let levelEl = null;
  let levelScore = Infinity;

  // The rail's rows share the grid's zone (see NavRail), so Down out of the last
  // loaded card found Settings at the screen's foot whenever the next page was
  // in flight. Down only, and only out of the content: inside the rail the Down
  // chain is declared, and Up into it from the top card row is intended.
  const skipRailRows = direction === 'down' && currentEntry?.railRow !== true;

  registry.forEach(({ el, zone, verticalOnly, crossZone, railRow }) => {
    if (el === currentEl) return;
    // A DOM-disabled element is an absorbing wall: `.focus()` is a silent no-op
    // and every press finds it, so focus never moves. The rating stepper's "−"
    // disabled while unrated made the detail action row a dead end.
    //
    // Checked on the element, not `useFocusable`'s option: call sites render
    // `disabled` without passing it, and reading the element cannot drift.
    // `aria-disabled` is not checked, it stays focusable by design.
    if (el.disabled) return;
    // See the flag notes at the top of this function.
    if (isHorizontal && verticalOnly) return;
    if (railRow && skipRailRows) return;
    if (isHorizontal && zone !== currentZone && !currentCrossesZones) return;
    if (scope && !scope.contains(el)) return;
    // Last, because it is a layout query: a deep listing registers every loaded
    // card, and most of them are ruled out by the cheap tests above.
    if (!isRendered(el)) return;

    const rect = getCachedRect(el);
    const dx = (rect.left + rect.width / 2) - curCx;
    const dy = (rect.top + rect.height / 2) - curCy;

    // Inside a wrapped row, a sideways press belongs to its physical line;
    // other lines are the wrap pass's job, in reading order. Elements outside
    // the container are split geometrically:
    //
    //  - Wholly beyond its edge in the travel direction (the rail, left of the
    //    controls bar) is a legitimate neighbour, scored normally, a hard
    //    boundary turned the bar into a sideways trap.
    //  - Overlapping its horizontal span on another line (the marker-chip row
    //    above the scene actions) is excluded; allowing it made Right jump into
    //    the middle of the actions and Left jump back mid-row.
    //
    // Compared against the container's box: the current element may be
    // anywhere along its line.
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
    let level = false;
    switch (direction) {
      case 'up':
        if (dy >= -LEVEL_FALLBACK) return;
        level = dy >= -LEVEL_TOLERANCE;
        primary = -dy; secondary = dx < 0 ? -dx : dx; break;
      case 'down':
        if (dy <= LEVEL_FALLBACK) return;
        level = dy <= LEVEL_TOLERANCE;
        primary = dy; secondary = dx < 0 ? -dx : dx; break;
      case 'left':  if (dx >= -4) return; primary = -dx; secondary = dy < 0 ? -dy : dy; break;
      case 'right': if (dx <=  4) return; primary =  dx; secondary = dy < 0 ? -dy : dy; break;
      default: return;
    }

    // Level means the next thing along this row, not the next row.
    if (level && zone === currentZone) return;

    let score = primary + secondary * 1.5;
    if (!isHorizontal && zone !== currentZone && !crossZone) score += CROSS_ZONE_PENALTY;
    if (currentScroll && !currentScroll.contains(el)) score += CONTAINER_EXIT_PENALTY;

    if (level) {
      if (score < levelScore) { levelScore = score; levelEl = el; }
    } else if (score < bestScore) { bestScore = score; bestEl = el; }
  });

  // End of a wrapped line: continue at the start of the next, chosen by line
  // edge then position within it, reading order the scoring above cannot
  // produce, since the next line starts *behind*. Left is the mirror.
  if (!bestEl && isHorizontal && wrapContainer) {
    const goingRight = direction === 'right';
    let bestKey = Infinity;
    registry.forEach(({ el, zone, verticalOnly }) => {
      if (el === currentEl || el.disabled) return;
      if (verticalOnly) return;
      if (zone !== currentZone && !currentCrossesZones) return;
      if (scope && !scope.contains(el)) return;
      if (!wrapContainer.contains(el)) return;
      if (!isRendered(el)) return;
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

  return bestEl || levelEl;
}

export function useKeyHandler({ onBack } = {}) {
  // A ref keeps the handler current while the effect runs once; otherwise every
  // App render re-adds the listeners and drops `is-navigating` mid-burst.
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
        // In a text field Left/Right belong to the caret. Up/Down do not move
        // it in a single-line input (the default jumps to the value's ends and
        // traps the user), so those still navigate spatially.
        const ae = document.activeElement;
        const inText = isTextInput(ae);
        const isHorizontal = direction === 'left' || direction === 'right';
        if (inText && isHorizontal) return;

        // A TEXTAREA does move the caret between lines, so Up/Down stay native.
        if (inText && ae.tagName === 'TEXTAREA') return;

        e.preventDefault();

        // Throttle held-key repeats, TV remotes spam keydown ~30 Hz.
        const now = performance.now();
        if (now - lastNavAt < MIN_REPEAT_MS) return;
        lastNavAt = now;
        setNavigating();

        // Clear per press: CSS transitions and re-renders move things without
        // a scroll/resize event, and one Map allocation is cheap.
        rectCacheRef.current = new WeakMap();

        const currentId = getCurrentFocusId();
        const currentEntry = currentId ? registry.get(currentId) : null;
        const currentEl = currentEntry?.el || document.activeElement;

        if (currentEl && registry.size > 0) {
          const best = findBestCandidate(direction, currentEl, currentEntry);
          if (best) best.focus();
        } else {
          for (const { el } of registry.values()) {
            // Disabled elements stay registered so the current one keeps its
            // zone, but focusing one is a no-op and strands the user on <body>.
            if (isRendered(el) && !el.disabled) { el.focus(); break; }
          }
        }
        return;
      }

      if (key === 'Backspace' || isBackCode(e.keyCode)) {
        // One press, one layer: an unguarded repeat closes the player, then the
        // page under it, then the exit prompt.
        if (e.repeat) return;
        // The on-screen keyboard's delete sends Backspace; let it delete while
        // a text field has focus. Tizen Back (10009) still triggers onBack, it
        // is a hardware key with no text-editing meaning.
        if (key === 'Backspace' && isTextInput(document.activeElement)) return;
        onBackRef.current?.();
      }
    };

    // Geometry changes, drop cached rects.
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