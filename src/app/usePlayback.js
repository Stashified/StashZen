/**
 * usePlayback — the player, the long-press menu, and every way into both.
 *
 * Every entry point produces the same shape — a queue plus the index to
 * start at — so the player has one code path rather than a "single video"
 * one and a "queue" one that can drift apart. See playQueue.js.
 */

import { useCallback, useState } from 'react';
import { queueOf, queueItemFromMarker } from '../utils/playQueue.js';

export function usePlayback({
  selectedScene,
  setSelectedScene,
  mainFocus,
  sceneCardFocus,
  menuCardFocus,
}) {
  // The playback session: an ordered queue of scenes plus where to start in
  // it. Null when nothing is playing. One scene is the ordinary case — the
  // detail page's Play and a marker both open a queue of one; a longer queue
  // is Play all / Play from here, and it is what the player's ↑/↓ walks.
  const [playSession, setPlaySession] = useState(null);
  // The long-press menu: `{ video, list, index }` for the card it opened on.
  const [actionMenu, setActionMenu] = useState(null);

  const openPlayer = (session) => {
    setSelectedScene(null);
    setActionMenu(null);
    setPlaySession(session);
  };

  // Stable pieces only: the useRestoreFocus() objects are rebuilt every
  // render, but their `remember` callbacks are not. Depending on the objects
  // would give every card a new onLongPress identity on each App render and
  // undo the memoization.
  const rememberMenuCard = menuCardFocus.remember;
  const rememberMain = mainFocus.remember;
  const handleVideoLongPress = useCallback((video, list, index) => {
    rememberMenuCard(document.activeElement);
    // The menu's Play / Play all / Play from here open the player without ever
    // going through `playSceneAt`, which is the only other thing that records a
    // restore target for it. Without this the player's Back put focus on a
    // stale control from an earlier overlay — or on <body>, leaving the D-pad
    // with nothing to move from. The menu's own close uses the same element.
    rememberMain(document.activeElement);
    setActionMenu({ video, list, index });
  }, [rememberMenuCard, rememberMain]);

  const closeActionMenu = () => {
    setActionMenu(null);
    // Same deferred restore as every other overlay close: the menu's DOM has
    // to be gone before focus can land on the card again.
    menuCardFocus.restore();
  };

  const handleMenuDetails = (video) => {
    // The card takes focus back when the detail page closes, so hand it over
    // now — the menu is about to be gone.
    sceneCardFocus.remember(menuCardFocus.targetRef.current);
    setActionMenu(null);
    setSelectedScene(video);
  };

  // Play and a marker differ only in where playback starts. Both keep the
  // same focus restore: when the player closes, focus goes back to the card,
  // not to the detail page that is already gone.
  //
  // `resumeTime` is the detail page's freshly fetched value, when it has one.
  // The card the queue is built from may be stale — the listing behind the
  // page is not refetched after a save — and the player decides whether to
  // raise the resume prompt from this item. A marker's `seconds` still means
  // "start here", which suppresses the prompt for that press.
  const playSceneAt = (seconds = 0, resumeTime = null) => {
    mainFocus.remember(sceneCardFocus.targetRef.current);
    const scene = resumeTime == null
      ? selectedScene
      : { ...selectedScene, resume_time: resumeTime };
    openPlayer(queueOf(scene, seconds));
  };

  const handleScenePlay = (resumeTime) => playSceneAt(0, resumeTime);

  const handleMarkerSelect = (marker) => {
    mainFocus.remember(document.activeElement);
    // A marker is a timestamp inside a scene, so the queue item is built by
    // hand — see queueItemFromMarker for the fields it must forward.
    openPlayer(queueOf(queueItemFromMarker(marker), marker.seconds || 0));
  };

  const handlePlayerClose = () => {
    setPlaySession(null);
    mainFocus.restore();
  };

  return {
    playSession,
    actionMenu,
    openPlayer,
    handlePlayerClose,
    handleVideoLongPress,
    closeActionMenu,
    handleMenuDetails,
    playSceneAt,
    handleScenePlay,
    handleMarkerSelect,
  };
}
