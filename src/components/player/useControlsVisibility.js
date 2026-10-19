/**
 * useControlsVisibility — whether the rail is up, and the timer that puts it
 * away.
 *
 * One timer and one rule: the controls hide when it expires, unless the rail
 * still holds the cursor. Everything that counts as activity calls
 * `showControls`; everything that is a deliberate exit calls `leaveRail`, which
 * blurs first and hides the bar outright, or `hideControls` when the cursor is
 * already out of it (Back with the rail down).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTROLS_HIDE_DELAY } from './constants.js';

export function useControlsVisibility({ railRef }) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef(null);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      // ...but never out from under the cursor. A focus ring that disappears
      // on its own reads as a dropped keypress, and the press after it would
      // land on <body> with nothing to receive it. Leaving the rail re-arms
      // this, so the rail still goes away once nobody is on it.
      if (railRef.current?.holdsFocus()) return;
      setControlsVisible(false);
    }, CONTROLS_HIDE_DELAY);
  }, [railRef]);

  // Opening the rail. `showControls` first so the container is on its way to
  // `opacity: 1` before the cursor lands in it, then focus ⏯ — the cursor
  // radiates out from the middle of the row, and the button the user is most
  // likely to want is the one they pressed OK for.
  //
  // Focusing a rail that is still at `opacity: 0` would work (the elements are
  // rendered, not `display: none`), but the ring would arrive before the
  // controls did.
  const revealRail = useCallback(() => {
    showControls();
    railRef.current?.focusPlayPause();
  }, [showControls, railRef]);

  // Hiding it outright, with the cursor already behind it. Back is the caller
  // when the rail is down and the bar is on screen: the bar goes on that press
  // and the player closes on the next one. The warning above still applies —
  // never pull the bar out from under the cursor — so this refuses while the
  // rail holds focus; Back inside the rail goes through `leaveRail`.
  const hideControls = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
    if (railRef.current?.holdsFocus()) return;
    setControlsVisible(false);
  }, [railRef]);

  // Leaving it. Blur to <body> rather than focusing the player container, and
  // that is not a detail: focusing the container would resolve
  // `focusScopeOf` to the player's *own* dialog, so the player would go on
  // yielding the arrows — skim would be dead, with nothing on screen to
  // explain why.
  //
  // The bar goes with the cursor rather than lingering for the auto-hide
  // timer: Back is "one level up" in both directions now — it leaves the rail
  // *and* dismisses the bar, and the press after it closes the player. Hiding
  // outright is also what makes the two Back presses predictable; a bar that
  // stayed up for three more seconds read as a press that did nothing.
  const leaveRail = useCallback(() => {
    document.activeElement?.blur?.();
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
    setControlsVisible(false);
  }, []);

  // The timer must not outlive the player.
  useEffect(() => () => clearTimeout(hideTimerRef.current), []);

  return { controlsVisible, showControls, revealRail, leaveRail, hideControls };
}
