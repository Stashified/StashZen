/**
 * useControlsVisibility — whether the rail is up, and the timer that puts it
 * away.
 *
 * One timer, one rule: the controls hide when it expires unless the rail still
 * holds the cursor. Activity calls `showControls`; a deliberate exit calls
 * `leaveRail` (blur, then hide) or `hideControls` (cursor already out).
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
      // ...but never out from under the cursor: a focus ring that vanishes on
      // its own reads as a dropped keypress, and the next press would land on
      // <body>. Leaving the rail re-arms this.
      if (railRef.current?.holdsFocus()) return;
      setControlsVisible(false);
    }, CONTROLS_HIDE_DELAY);
  }, [railRef]);

  // Opening the rail. `showControls` first, so the container is on its way to
  // `opacity: 1` before the cursor lands: focusing a rail at opacity 0 works,
  // but the ring would arrive before the controls did. Focus ⏯ because the
  // cursor radiates from the middle and that is the likely intent.
  const revealRail = useCallback(() => {
    showControls();
    railRef.current?.focusPlayPause();
  }, [showControls, railRef]);

  // Hiding it outright with the cursor already out. Back calls this when the
  // rail is down and the bar is up: the bar goes on that press, the player on
  // the next. It refuses while the rail holds focus — never pull the bar from
  // under the cursor; Back inside the rail goes through `leaveRail`.
  const hideControls = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
    if (railRef.current?.holdsFocus()) return;
    setControlsVisible(false);
  }, [railRef]);

  // Leaving it. Blur to <body> rather than focusing the player container:
  // that would resolve `focusScopeOf` to the player's *own* dialog, so the
  // player would keep yielding the arrows and skim would be silently dead.
  //
  // The bar goes with the cursor rather than lingering: Back is "one level up"
  // in both directions, and a bar that stayed up would read as a press that did
  // nothing.
  const leaveRail = useCallback(() => {
    document.activeElement?.blur?.();
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
    setControlsVisible(false);
  }, []);

  // ↑ from the rail is seek mode, not a dismissal: the cursor leaves the
  // buttons and the bar stays up, so ←/→ skim a visible timeline. The auto-hide
  // timer is re-armed as for any other activity.
  const leaveRailToSeek = useCallback(() => {
    document.activeElement?.blur?.();
    showControls();
  }, [showControls]);

  // The timer must not outlive the player.
  useEffect(() => () => clearTimeout(hideTimerRef.current), []);

  return {
    controlsVisible, showControls, revealRail,
    leaveRail, leaveRailToSeek, hideControls,
  };
}
