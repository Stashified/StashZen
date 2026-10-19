/**
 * useDetailSelection — what is open *in front of* a listing: a scene detail
 * page, a performer page, or the image viewer.
 *
 * Each is held as an id-carrying record from the listing rather than being
 * fetched by the overlay, so the detail page paints immediately and adopts
 * the server's fuller answer afterwards. The state is App's rather than the
 * page's because Back, tab changes and the data source all have to be able
 * to close it.
 */

import { useEffect, useState } from 'react';
import { useRestoreFocus } from '../hooks/useRestoreFocus.js';
import { focusByIdWhenReady } from '../utils/focus.js';

export function useDetailSelection({ activeTab, dataKey, changeTab }) {
  const [selectedPerformer, setSelectedPerformer] = useState(null);
  // Where a performer detail opened from Home returns to. Separate from
  // `filterOrigin` because that one means "a filtered listing and its Back
  // destination"; reusing it would make Back from a detail opened *inside* a
  // See-all Performers listing skip the Performers grid and jump Home.
  // Null means the ordinary case — opened from the Performers grid, where
  // `performerCardFocus` already knows the card.
  const [performerOrigin, setPerformerOrigin] = useState(null);
  const [selectedScene, setSelectedScene] = useState(null);
  // Scenes whose resume point was cleared from the detail overlay while Home
  // was mounted underneath it. The showroom cannot refetch in place — its five
  // requests run once on mount — so App tells it which cards to drop. Cleared
  // on every tab arrival: the next visit asks the server, which is the truth.
  const [clearedContinueIds, setClearedContinueIds] = useState(() => new Set());
  // The full-screen image viewer: `{ items, index }`, where `items` is the
  // listing snapshot the grid handed over at the moment the card was pressed.
  // Null when closed. Held here rather than inside the images page so that
  // closing it is App's business like every other overlay's.
  const [imageViewer, setImageViewer] = useState(null);

  // Focus restore targets this hook's overlays use. `mainFocus` (in App) is
  // the shared one (builder, player, settings, exit); these remember the card
  // the overlay was opened from.
  const performerCardFocus = useRestoreFocus();
  const sceneCardFocus = useRestoreFocus();
  const imageCardFocus = useRestoreFocus();

  // The prune above is a patch on the Home that is already mounted, nothing
  // more — so it dies with that Home. A tab change remounts the showroom and
  // it fetches the shelf again; a data-source change does the same for a
  // different library, where the same id means something else entirely.
  useEffect(() => {
    setClearedContinueIds(prev => (prev.size ? new Set() : prev));
  }, [activeTab, dataKey]);

  // A data-source change discards the details: each holds an id and a record
  // from the old library, and the new listing cannot back either up. See
  // useListingControls for why this is a render-phase update.
  const [detailForSource, setDetailForSource] = useState(null);
  if (detailForSource !== dataKey) {
    setDetailForSource(dataKey);
    if (selectedScene) setSelectedScene(null);
    if (selectedPerformer) setSelectedPerformer(null);
    if (performerOrigin) setPerformerOrigin(null);
  }

  // Leaving the Performers tab clears any open detail page so the
  // user doesn't pop back into someone they forgot they'd selected. The
  // origin is cleared with it: left behind, it would fire the next time a
  // performer was opened from the grid and send Back to Home instead.
  useEffect(() => {
    if (activeTab !== 'performers') {
      if (selectedPerformer) setSelectedPerformer(null);
      if (performerOrigin) setPerformerOrigin(null);
    }
  }, [activeTab, selectedPerformer, performerOrigin]);

  // Same for a scene detail page. It can be open over Scenes, Performers or
  // Markers, and switching tabs underneath it would leave the overlay
  // showing a scene from a listing the user has just navigated away from.
  useEffect(() => {
    if (selectedScene) setSelectedScene(null);
  }, [activeTab]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Enter on a scene card opens the detail page rather than playing
  // straight away; playback moved to the page's Play button. Markers are
  // deliberately left on the old path (see handleMarkerSelect) — a marker
  // is a timestamp inside a scene, so putting a scene browser in front of
  // it would drop the position the user actually asked for.
  const handleVideoSelect = (video) => {
    sceneCardFocus.remember(document.activeElement);
    setSelectedScene(video);
  };

  const handleSceneClose = () => {
    setSelectedScene(null);
    // The grid is still mounted underneath — the overlay never unmounted it
    // — so the originating card is still in the DOM to take focus back.
    // Deferred a tick, same as the player and settings closes.
    sceneCardFocus.restore({
      // Except when the card is gone: clearing the scene's progress prunes it
      // from Continue Watching while this overlay is still up. Fall back to
      // the first control in the page rather than stranding the cursor on
      // <body>, where no D-pad press can move it.
      fallback: () => {
        const first = document.querySelector('[role="main"] [tabindex="0"]:not([disabled])');
        if (first) first.focus();
      },
    });
  };

  // The detail page's one report back into this tree. Only a cleared resume
  // point changes what Home is drawing; a play count and a like are facts the
  // shelf does not show, so they are deliberately not forwarded.
  const handleSceneActivityChange = (sceneId, patch) => {
    if (patch?.resumeTime !== 0) return;
    const id = String(sceneId);
    // The detail page's own state has the cleared value, but `selectedScene` is
    // the card it was opened from — and Play/markers build the player's queue
    // from it. Left alone, a scene cleared at the detail page still raises the
    // "resume from …" prompt on the Play press that follows, for a position the
    // user just explicitly discarded.
    setSelectedScene(s => (s && String(s.id) === id ? { ...s, resume_time: 0 } : s));
    setClearedContinueIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const handlePerformerSelect = (performer) => {
    // A press in the Performers grid always wins over a stale Home origin.
    setPerformerOrigin(null);
    performerCardFocus.remember(document.activeElement);
    setSelectedPerformer(performer);
  };

  // A performer opened from the Home shelf. The detail page only renders
  // under `activeTab === 'performers'`, so this switches tab — and
  // `performerCardFocus` is deliberately not used: the card that was
  // pressed is on Home and unmounts with the switch, so the element could
  // never be focused on the way back. The origin names it by id instead.
  const handleShowroomPerformerSelect = (performer) => {
    setPerformerOrigin({ focusId: `performer-${performer.id}` });
    setSelectedPerformer(performer);
    changeTab('performers');
  };

  const handlePerformerBack = () => {
    setSelectedPerformer(null);
    if (performerOrigin) {
      const { focusId } = performerOrigin;
      setPerformerOrigin(null);
      changeTab('home');
      // Home remounts and refetches its four shelves, so the card does not
      // exist yet at this moment. The retry loop is what `activateFiltered`'s
      // Back uses for the same reason.
      focusByIdWhenReady(focusId);
      return;
    }
    // Restore focus to the originating card after the grid remounts.
    performerCardFocus.restore();
  };

  // An image has no listing behind it to route to, so it opens the one screen
  // that shows it at size. The viewer is handed the listing the grid had
  // loaded rather than the item alone, because a viewer you cannot step
  // through is just a bigger card.
  const handleImageSelect = (image, index, items) => {
    imageCardFocus.remember(document.activeElement);
    setImageViewer({
      items: items?.length ? items : [image],
      // A Carousel passes the index too; the `??` is for the click path, where
      // it is absent. Landing on image 1 of the wrong listing would be worse
      // than landing on the first, so the fallback is deliberate.
      index: typeof index === 'number' ? index : 0,
    });
  };

  const closeImageViewer = () => {
    setImageViewer(null);
    // Same deferred restore as every other overlay close: the viewer's DOM has
    // to be gone before focus can land on the card again.
    imageCardFocus.restore();
  };

  return {
    selectedPerformer,
    performerOrigin,
    selectedScene,
    setSelectedScene,
    clearedContinueIds,
    imageViewer,
    setImageViewer,
    sceneCardFocus,
    performerCardFocus,
    handleVideoSelect,
    handleSceneClose,
    handleSceneActivityChange,
    handlePerformerSelect,
    handleShowroomPerformerSelect,
    handlePerformerBack,
    handleImageSelect,
    closeImageViewer,
  };
}
