/**
 * useDetailSelection: what is open *in front of* a listing: a scene detail
 * page, a performer page, or the image viewer.
 *
 * Each is an id-carrying record from the listing rather than a fetch, so the
 * detail page paints immediately and adopts the server's fuller answer after.
 * The state is App's because Back, tab changes and the data source all have to
 * be able to close it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRestoreFocus } from '../hooks/useRestoreFocus.js';
import { focusByIdWhenReady, focusFirstControl } from '../utils/focus.js';

export function useDetailSelection({ activeTab, dataKey, changeTab }) {
  const [selectedPerformer, setSelectedPerformer] = useState(null);
  // Where a performer detail opened from Home returns to. Separate from
  // `filterOrigin`, which means "a filtered listing and its Back destination";
  // reusing it would make Back from a detail opened inside a See-all Performers
  // listing skip the grid and jump Home. Null means the Performers grid.
  const [performerOrigin, setPerformerOrigin] = useState(null);
  const [selectedScene, setSelectedScene] = useState(null);
  // Scenes whose resume point was cleared from the detail overlay while Home
  // was mounted underneath. The showroom cannot refetch in place, so App says
  // which cards to drop; cleared on every tab arrival, when the server is asked.
  const [clearedContinueIds, setClearedContinueIds] = useState(() => new Set());
  // The full-screen image viewer: `{ items, index }`, the listing snapshot the
  // grid handed over when the card was pressed. Null when closed; held here so
  // closing it is App's business like every other overlay's.
  const [imageViewer, setImageViewer] = useState(null);

  // Focus restore targets: `mainFocus` (in App) is the shared one; these
  // remember the card the overlay was opened from.
  //
  // The performer page has none: its grid is unmounted while the page is up, so
  // a remembered element is detached by the time Back runs and focusing it
  // leaves the cursor on <body>. It restores by id instead.
  const sceneCardFocus = useRestoreFocus();
  const imageCardFocus = useRestoreFocus();

  // The prune patches the Home already mounted, so it dies with that Home: a
  // tab change remounts the showroom and refetches, and a data-source change
  // swaps in a library where the id means something else.
  useEffect(() => {
    setClearedContinueIds(prev => (prev.size ? new Set() : prev));
  }, [activeTab, dataKey]);

  // A data-source change discards the details: each holds an id and a record
  // from the old library. See useListingControls for the render-phase update.
  const [detailForSource, setDetailForSource] = useState(null);
  if (detailForSource !== dataKey) {
    setDetailForSource(dataKey);
    if (selectedScene) setSelectedScene(null);
    if (selectedPerformer) setSelectedPerformer(null);
    if (performerOrigin) setPerformerOrigin(null);
  }

  // Leaving Performers clears any open detail so the user does not pop back
  // into someone they forgot. The origin is cleared with it, or the next
  // performer opened from the grid would send Back to Home.
  useEffect(() => {
    if (activeTab !== 'performers') {
      if (selectedPerformer) setSelectedPerformer(null);
      if (performerOrigin) setPerformerOrigin(null);
    }
  }, [activeTab, selectedPerformer, performerOrigin]);

  // Same for a scene detail: switching tabs underneath it would leave an
  // overlay showing a scene from a listing just navigated away from.
  useEffect(() => {
    if (selectedScene) setSelectedScene(null);
  }, [activeTab]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Enter on a scene card opens the detail page; playback moved to its Play
  // button. Markers stay on the old path (see handleMarkerSelect), a scene
  // browser in front of one would drop the position asked for. `remember` is
  // stable; depending on the fresh useRestoreFocus() object would defeat the
  // memoised cards this feeds.
  const rememberSceneCard = sceneCardFocus.remember;
  const handleVideoSelect = useCallback((video) => {
    rememberSceneCard(document.activeElement);
    setSelectedScene(video);
  }, [rememberSceneCard]);

  const handleSceneClose = () => {
    setSelectedScene(null);
    // The grid is still mounted underneath, so the originating card is in the
    // DOM to take focus back. Deferred a tick, same as the player and settings.
    sceneCardFocus.restore({
      // Except when the card is gone (clearing progress prunes it from
      // Continue Watching): fall back to the first control, not <body>.
      fallback: focusFirstControl,
    });
  };

  // Only a cleared resume point changes what Home draws; play counts and likes
  // are not shown on the shelf.
  const handleSceneActivityChange = (sceneId, patch) => {
    if (patch?.resumeTime !== 0) return;
    const id = String(sceneId);
    // `selectedScene` is the card the queue is built from, so clear its resume
    // time too, otherwise the next Play raises the prompt for a position the
    // user just discarded.
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
    setSelectedPerformer(performer);
  };

  // A performer opened from the Home shelf or the search page. The page only
  // renders under `activeTab === 'performers'`, and the pressed card unmounts
  // with the switch, so the origin names the tab and card by id.
  const openPerformerFrom = (performer, tab) => {
    setPerformerOrigin({ focusId: `performer-${performer.id}`, tab });
    setSelectedPerformer(performer);
    changeTab('performers');
  };

  const handleShowroomPerformerSelect = (performer) => openPerformerFrom(performer, 'home');
  const handleSearchPerformerSelect = (performer) => openPerformerFrom(performer, 'search');

  const handlePerformerBack = () => {
    const performer = selectedPerformer;
    setSelectedPerformer(null);
    if (performerOrigin) {
      const { focusId, tab } = performerOrigin;
      setPerformerOrigin(null);
      changeTab(tab || 'home');
      // The origin tab remounts and refetches, so the card does not exist yet;
      // retry as `activateFiltered`'s Back does.
      focusByIdWhenReady(focusId, { fallback: focusFirstControl });
      return;
    }
    // The Performers grid remounts in this commit and fetches page 1, so the
    // card is gone now, or, after scrolling, not in that page. The restore
    // waits and pages the grid forward; see utils/focus.js.
    if (performer) focusByIdWhenReady(`performer-${performer.id}`);
  };

  // An image has no listing to route to, so it opens the one screen that shows
  // it at size. The viewer gets the listing the grid had loaded, because a
  // viewer you cannot step through is just a bigger card.
  //
  // `openImageViewer` is the general form for the long-press menu: it takes the
  // descriptor as-is (`items`/`index` or `gallery`/`shuffle`) plus `restoreEl`,
  // the card focus must come back to when the viewer closes.
  const openImageViewer = (descriptor) => {
    if (descriptor?.restoreEl) imageCardFocus.remember(descriptor.restoreEl);
    setImageViewer(descriptor);
  };

  const handleImageSelect = (image, index, items) => {
    openImageViewer({
      items: items?.length ? items : [image],
      // A Carousel passes the index; a click does not. Landing on image 1 of
      // the wrong listing is worse than the first, so 0 is deliberate.
      index: typeof index === 'number' ? index : 0,
      restoreEl: document.activeElement,
    });
  };

  const closeImageViewer = () => {
    const viewer = imageViewer;
    setImageViewer(null);
    // A listing viewer steps through its cards and App is told the index on
    // every step: return to the card on screen, not the one it opened on. A
    // gallery slideshow has no cards, so it keeps the gallery card.
    const item = viewer && !viewer.gallery ? viewer.items?.[viewer.index] : null;
    if (item?.id != null) {
      // Deferred like every other overlay close: the viewer's DOM has to be
      // gone before focus lands, or the browser settles it back to <body>.
      setTimeout(() => focusByIdWhenReady(`image-${item.id}`), 50);
      return;
    }
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
    handleVideoSelect,
    handleSceneClose,
    handleSceneActivityChange,
    handlePerformerSelect,
    handleShowroomPerformerSelect,
    handleSearchPerformerSelect,
    handlePerformerBack,
    handleImageSelect,
    openImageViewer,
    closeImageViewer,
  };
}
