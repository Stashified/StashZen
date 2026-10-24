/**
 * usePlayerKeys — installs the player's capture-phase key listener.
 *
 * The listener is deliberately thin: `routePlayerKey` decides everything
 * (which action, whether to preventDefault, whether to stopPropagation) and
 * this hook only performs the action. The map itself is unit-tested directly
 * in scripts/test-key-routing.mjs.
 */

import { useEffect } from 'react';
import { SKIP_SECONDS } from './constants.js';
import { foreignDialogOpen, routePlayerKey } from './keyRouting.js';

export function usePlayerKeys({
  onClose,
  containerRef,
  railRef,
  mediaTransport,
  skim,
  revealRail,
  leaveRail,
  leaveRailToSeek,
  hideControls,
  controlsVisible,
  stepScene,
  singleScene,
}) {
  // Keyboard handling — capture phase, so the player sees every key first.
  //
  // Two things can take a key away from it, and neither is "the controller
  // was busy": an overlay that is not the player's own (the marker form, the
  // detail page), and its own rail, which owns ←/→/↓ and Enter so that spatial
  // nav and the focused button receive them. Everything else is handled here.
  useEffect(() => {
    const handleKey = (e) => {
      const { action, prevent, stop } = routePlayerKey(e, {
        railHoldsFocus: Boolean(railRef.current?.holdsFocus()),
        foreignDialog: foreignDialogOpen(containerRef.current),
        singleScene,
        controlsVisible,
      });
      // The order matters: the flags are decided by the route, not by the
      // branch that performs the action.
      if (prevent) e.preventDefault();
      if (stop) e.stopPropagation();

      switch (action) {
        case 'media': mediaTransport(e.keyCode); break;
        case 'step-prev': stepScene(-1); break;
        case 'step-next': stepScene(1); break;
        case 'leave-rail': leaveRail(); break;
        case 'leave-rail-seek': leaveRailToSeek(); break;
        case 'hide-controls': hideControls(); break;
        case 'close': onClose?.(); break;
        case 'reveal-rail': revealRail(); break;
        case 'skim-back': skim(-SKIP_SECONDS); break;
        case 'skim-forward': skim(SKIP_SECONDS); break;
        default: break;
      }
    };

    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [
    onClose, mediaTransport, skim, revealRail, leaveRail, leaveRailToSeek,
    hideControls, controlsVisible, stepScene, singleScene, containerRef, railRef,
  ]);
}
