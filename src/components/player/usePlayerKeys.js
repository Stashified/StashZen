/**
 * usePlayerKeys: installs the player's capture-phase key listener.
 *
 * Deliberately thin: `routePlayerKey` decides everything (action, preventDefault,
 * stopPropagation) and this hook only performs it. The map is unit-tested in
 * scripts/test-key-routing.mjs.
 */

import { useEffect } from 'react';
import { foreignDialogOpen, routePlayerKey } from './keyRouting.js';
import { getCurrentFocusId } from '../../hooks/useFocusable.js';
import { focusByIdWhenReady } from '../../utils/focus.js';

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
  upNextVisible,
  hideUpNext,
}) {
  // Keyboard handling, capture phase, so the player sees every key first.
  // Two things take a key away: a foreign overlay (marker form, detail page),
  // and the player's own rail, which owns ←/→/↓ and Enter for spatial nav and
  // the focused button. Everything else is handled here.
  useEffect(() => {
    const handleKey = (e) => {
      const { action, prevent, stop } = routePlayerKey(e, {
        railHoldsFocus: Boolean(railRef.current?.holdsFocus()),
        foreignDialog: foreignDialogOpen(containerRef.current),
        singleScene,
        controlsVisible,
        upNextVisible,
        // Read from the registry rather than kept as state: the route needs it
        // at keydown time, and the card's own ids are the whole test.
        upNextFocused: (getCurrentFocusId() || '').startsWith('upnext-'),
      });
      // The flags come from the route, not from the branch performing the
      // action; apply them before it.
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
        case 'skim-back': skim(-1, e.repeat); break;
        case 'skim-forward': skim(1, e.repeat); break;
        case 'enter-upnext': focusByIdWhenReady('upnext-play'); break;
        case 'hide-upnext': hideUpNext?.(); break;
        default: break;
      }
    };

    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [
    onClose, mediaTransport, skim, revealRail, leaveRail, leaveRailToSeek,
    hideControls, controlsVisible, stepScene, singleScene, upNextVisible,
    hideUpNext, containerRef, railRef,
  ]);
}
