/**
 * usePlayback: the player, the long-press menu, and every way into both.
 *
 * Every entry point produces the same shape, a queue plus the index to start
 * at, so the player has one code path. The long-press menu is not scene-only:
 * markers, images and galleries each carry a `kind` so the overlay can ask
 * actionMenus.js for the right rows. Focus bookkeeping is shared: the menu
 * remembers the card it opened on, the player where to return.
 */

import { useCallback, useRef, useState } from 'react';
import { queueOf, queueItemFromMarker } from '../utils/playQueue.js';
import { focusByIdWhenReady, focusFirstControl } from '../utils/focus.js';

/** Which entity sections have a long-press menu, and what to call it. */
const ENTITY_MENU_KIND = {
  images: 'image',
  galleries: 'gallery',
  tags: 'tag',
  studios: 'studio',
};

export function usePlayback({
  activeTab,
  selectedScene,
  setSelectedScene,
  mainFocus,
  sceneCardFocus,
  menuCardFocus,
}) {
  // The playback session: an ordered queue of scenes plus where to start. Null
  // when nothing is playing. One scene is the ordinary case; a longer queue is
  // Play all / Play from here, which the player's ↑/↓ walks.
  const [playSession, setPlaySession] = useState(null);
  // The long-press menu: `{ kind, item, list, index }` for the card it opened
  // on. `kind` is 'scene' | 'marker' | 'image' | 'gallery' | 'tag' | 'studio'.
  const [actionMenu, setActionMenu] = useState(null);
  // The queue row the player shows *now*: a listing queue can be skipped
  // through, and Back returns to the card of the scene actually on screen. The
  // row, not its id, a marker queue names its card with `markerId`.
  const lastItemRef = useRef(null);

  const openPlayer = (session) => {
    lastItemRef.current = session?.items?.[session?.startIndex ?? 0] ?? null;
    setSelectedScene(null);
    setActionMenu(null);
    setPlaySession(session);
  };

  // The player's report on every scene change.
  const handlePlayerSceneChange = (item) => {
    lastItemRef.current = item ?? null;
  };

  // Stable pieces only: the useRestoreFocus() objects are rebuilt every
  // render, but their `remember` callbacks are not. Depending on the objects
  // would give every card a new onLongPress identity and undo memoization.
  const rememberMenuCard = menuCardFocus.remember;
  const rememberMain = mainFocus.remember;
  const openMenu = useCallback((menu) => {
    rememberMenuCard(document.activeElement);
    setActionMenu(menu);
  }, [rememberMenuCard]);

  const handleVideoLongPress = useCallback((video, list, index) => {
    // The menu's Play actions open the player without `playSceneAt`, the only
    // other recorder of a restore target; without this the player's Back lands
    // on a stale control or <body>. The menu's own close uses this element.
    rememberMain(document.activeElement);
    openMenu({ kind: 'scene', item: video, list, index });
  }, [rememberMain, openMenu]);

  // A marker's menu plays the parent scene from the marker's timestamp; the
  // focus restore is the same as a scene card's.
  const handleMarkerLongPress = useCallback((marker, list, index) => {
    rememberMain(document.activeElement);
    openMenu({ kind: 'marker', item: marker, list, index });
  }, [rememberMain, openMenu]);

  // Images and galleries open the same menu shell with different rows. The
  // viewer openers live in App (they own the viewer state), so this only
  // records the menu; App's handlers take it from there.
  const handleEntityLongPress = useCallback((item, index, list) => {
    const kind = ENTITY_MENU_KIND[activeTab];
    if (!kind) return;
    openMenu({ kind, item, list: list || null, index: index ?? 0 });
  }, [activeTab, openMenu]);

  const closeActionMenu = () => {
    setActionMenu(null);
    // Same deferred restore as every other overlay close: the menu's DOM has
    // to be gone before focus can land on the card again.
    menuCardFocus.restore();
  };

  // Clearing without restoring is what the viewer entries need: the viewer
  // takes focus itself, and restoring to the card first would fight its own
  // restore (and briefly drop the D-pad onto the grid behind the viewer).
  const dismissActionMenu = () => setActionMenu(null);

  const handleMenuDetails = (video) => {
    // The card takes focus back when the detail page closes, so hand it over
    // now, the menu is about to be gone.
    sceneCardFocus.remember(menuCardFocus.targetRef.current);
    setActionMenu(null);
    setSelectedScene(video);
  };

  // Play and a marker differ only in where playback starts; both restore focus
  // to the card when the player closes. `resumeTime` is the detail page's
  // freshly fetched value, the card may be stale because the listing behind
  // is not refetched after a save, and a marker's `seconds` means "start
  // here", suppressing the resume prompt.
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
    // hand, see queueItemFromMarker for the fields it must forward.
    openPlayer(queueOf(queueItemFromMarker(marker), marker.seconds || 0));
  };

  // Where a closed player puts the cursor: the card for the scene on screen
  // when Back was pressed, not the one the session started from. A scene queue
  // restores that listing's card, a marker queue its marker card; a
  // single-scene Play sets neither and keeps the element restore.
  //
  // The id prefix comes from the listing, not every scene card is
  // `video-<id>`; Home's shelves use `showroom-<shelf>-video-<id>`.
  const handlePlayerClose = () => {
    const session = playSession;
    const last = lastItemRef.current;
    setPlaySession(null);
    const videoPrefix = session?.focusPrefix || 'video';
    const focusId = session?.restoreBy === 'video' && last?.id != null
      ? `${videoPrefix}-${last.id}`
      : session?.restoreBy === 'marker' && last?.markerId != null
        ? `marker-${last.markerId}`
        : null;
    // Fall back to the element the player remembered when the last-viewed card
    // no longer exists (the queue left the listing, or a resume point cleared
    // the scene out of Continue Watching).
    const fallback = () => mainFocus.restore({ fallback: focusFirstControl });
    // Deferred: a dialog that opened while the player closed (the crash
    // panel's prompt) owns focus, and restoring would steal it.
    if (focusId) {
      setTimeout(() => {
        if (!document.querySelector('[role="dialog"]')) focusByIdWhenReady(focusId, { fallback });
      }, 50);
      return;
    }
    setTimeout(() => {
      if (!document.querySelector('[role="dialog"]')) fallback();
    }, 50);
  };

  return {
    playSession,
    actionMenu,
    openPlayer,
    handlePlayerClose,
    handlePlayerSceneChange,
    handleVideoLongPress,
    handleMarkerLongPress,
    handleEntityLongPress,
    closeActionMenu,
    dismissActionMenu,
    handleMenuDetails,
    playSceneAt,
    handleScenePlay,
    handleMarkerSelect,
    // The overlay handlers need the element the menu opened from, so an image
    // or gallery viewer returns focus to *that* card.
    menuCardFocus,
  };
}
