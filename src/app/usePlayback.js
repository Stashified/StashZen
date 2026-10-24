/**
 * usePlayback — the player, the long-press menu, and every way into both.
 *
 * Every entry point produces the same shape — a queue plus the index to
 * start at — so the player has one code path rather than a "single video"
 * one and a "queue" one that can drift apart. See playQueue.js.
 *
 * The long-press menu is not scene-only any more: markers, images and
 * galleries each open one, and the record carries a `kind` so the overlay can
 * ask actionMenus.js for the right rows. The focus bookkeeping is shared —
 * whatever the kind, the menu remembers the card it opened on and the player
 * remembers where to return.
 */

import { useCallback, useRef, useState } from 'react';
import { queueOf, queueItemFromMarker } from '../utils/playQueue.js';
import { focusByIdWhenReady, focusFirstControl } from '../utils/focus.js';

/** Which entity sections have a long-press menu, and what to call it. */
const ENTITY_MENU_KIND = { images: 'image', galleries: 'gallery' };

export function usePlayback({
  activeTab,
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
  // The long-press menu: `{ kind, item, list, index }` for the card it opened
  // on. `kind` is 'scene' | 'marker' | 'image' | 'gallery'.
  const [actionMenu, setActionMenu] = useState(null);
  // The queue row the player is showing *now*. A listing queue can be skipped
  // through, and Back has to return to the card of the scene the user was
  // actually on — not the one the session started from. The row, not its id:
  // a marker queue names its card with `markerId` while it plays a scene.
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
  // would give every card a new onLongPress identity on each App render and
  // undo the memoization.
  const rememberMenuCard = menuCardFocus.remember;
  const rememberMain = mainFocus.remember;
  const openMenu = useCallback((menu) => {
    rememberMenuCard(document.activeElement);
    setActionMenu(menu);
  }, [rememberMenuCard]);

  const handleVideoLongPress = useCallback((video, list, index) => {
    // The menu's Play / Play all / Play from here open the player without ever
    // going through `playSceneAt`, which is the only other thing that records a
    // restore target for it. Without this the player's Back put focus on a
    // stale control from an earlier overlay — or on <body>, leaving the D-pad
    // with nothing to move from. The menu's own close uses the same element.
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

  // Where a closed player puts the cursor. "Play all" / "Play from here" walk
  // a listing, so the card to return to is the one for the scene on screen
  // when Back was pressed — the user's last position, not the one the session
  // started from. The session says which listing it walks: a scene queue
  // restores that listing's scene card, and a marker queue (which plays
  // scenes, one per marker row) restores the marker card that row came from.
  // A single-scene Play sets neither — its card never changed — and keeps the
  // element restore.
  //
  // The card's id prefix comes from the listing, because not every scene card
  // is named `video-<id>`: Home's shelves register under
  // `showroom-<shelf>-video-<id>`. Assuming the grid's prefix there made the
  // restore poll for a card that could never appear. See ShowroomRow's `list`.
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
    // Falling back to the element the player remembered is the old behaviour,
    // and the right answer when the last-viewed card no longer exists (the
    // queue is not the grid's listing any more, or a resume point cleared the
    // scene out of Continue Watching).
    const fallback = () => mainFocus.restore({ fallback: focusFirstControl });
    if (focusId) {
      // Deferred like every overlay close, and then retried until the card
      // exists: the queue can have walked past the grid's loaded page, and
      // the registered listing pages forward to reach it — see utils/focus.js.
      setTimeout(() => focusByIdWhenReady(focusId, { fallback }), 50);
      return;
    }
    fallback();
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
    // The overlay handlers need the element the menu opened from: an image
    // or gallery the menu opens a viewer for must return focus to *that*
    // card, and this is where it was recorded.
    menuCardFocus,
  };
}
