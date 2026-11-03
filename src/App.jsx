/**
 * Root component: the active tab, the per-tab controls and the overlay stack.
 * The state behind them lives in `app/use*.js`; the page switch and overlays
 * in `app/TabContent.jsx` and `app/AppOverlays.jsx`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import NavRail from './components/NavRail.jsx';
import ControlsPanel from './components/ControlsPanel.jsx';
import { useRestoreFocus } from './hooks/useRestoreFocus.js';
import { useFlash } from './hooks/useFlash.js';
import { focusFirstControl } from './utils/focus.js';
import { publishRowPatch, publishRowRemove } from './utils/rowPatches.js';
import { queueOf } from './utils/playQueue.js';
import { fetchRandomVideo } from './utils/videoService.js';
import styles from './App.module.css';
import { useSettings, setSettings, dataSourceKey } from './utils/settings.js';
import { useAutoUpdateCheck } from './hooks/useAutoUpdateCheck.js';
import { useServerVersion } from './hooks/useServerVersion.js';
import { supportsCapability } from './utils/capabilities.js';
import { visibleSortGroups } from './utils/sortGroups.js';
import { TAB_CONTROL_CONFIG } from './app/tabConfig.js';
import { useTabNavigation } from './app/useTabNavigation.js';
import { useListingControls } from './app/useListingControls.js';
import { useActiveFilter } from './app/useActiveFilter.js';
import { useFilterBuilder } from './app/useFilterBuilder.js';
import { useFilteredNavigation } from './app/useFilteredNavigation.js';
import { useDetailSelection } from './app/useDetailSelection.js';
import { usePlayback } from './app/usePlayback.js';
import { useAppBack } from './app/useAppBack.js';
import TabContent from './app/TabContent.jsx';
import AppOverlays from './app/AppOverlays.jsx';

// The filter field each entity kind is reached through, per target tab. A kind
// whose field is absent from a target's filter schema has no count action; see
// EntityInfoOverlay's count tables.
const ENTITY_FILTER_FIELD = {
  tag: 'tags',
  studio: 'studios',
  group: 'groups',
  gallery: 'galleries',
};

// PerformerFilterType has no `galleries` criterion, so the gallery sheet's
// Performers count reaches them through the nested gallery filter instead.
// Its `id` is an IntCriterionInput, hence the Number.
const galleryPerformersFilter = (gallery) => ({
  galleries_filter: { id: { modifier: 'EQUALS', value: Number(gallery.id) } },
});

export default function App() {
  // Subscribing remounts the data tree on Test/Live or URL/key change, so
  // in-flight fetches and state from the previous source are discarded.
  const settings = useSettings();
  const dataKey = dataSourceKey(settings);
  // Capability-gated UI stays hidden until this resolves; see capabilities.js.
  const serverVersion = useServerVersion(dataKey);

  // Public builds only, and inside the PIN/FirstRun gates because App is what
  // they unmount: nothing is fetched before the user reaches the app.
  const updateCheck = useAutoUpdateCheck(settings);

  const { activeTab, tabEpoch, changeTab } = useTabNavigation();

  // The controls bar's state, view mode and grid columns; the render-phase
  // rules for what survives a tab or source change live here too.
  const {
    controls, setControls, updateControls, activeMode, setActiveMode,
  } = useListingControls({ activeTab, dataKey, settings });

  // Saved filters for the active tab.
  const config = TAB_CONTROL_CONFIG[activeTab];
  const filterMode = config?.filterMode || null;

  // Saved-filter list, selection, and the values the listing tabs fetch with.
  const {
    savedFilters,
    activeFilter,
    baseObjectFilter,
    activeObjectFilter,
    activeSearchQuery,
    filterOptions,
    setFiltersEpoch,
    setSavedFilterEcho,
  } = useActiveFilter({
    controls,
    filterMode,
    dataKey,
    quickFilterDefs: config?.quickFilters || [],
  });

  // A chip is a toggle, and the request state it lives in is the same one the
  // tab and source rules clear on arrival. The sort adoption in updateControls
  // only runs for `filterId`, so this is a plain state patch.
  const toggleQuickFilter = (id) => {
    const active = controls.quickFilters || [];
    updateControls({
      quickFilters: active.includes(id)
        ? active.filter(x => x !== id)
        : [...active, id],
    }, savedFilters);
  };

  // Focus restore targets: `mainFocus` is shared by builder, player, settings
  // and exit; the card targets belong to the overlay hooks.
  const mainFocus = useRestoreFocus();
  const menuCardFocus = useRestoreFocus();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exitPromptOpen, setExitPromptOpen] = useState(false);
  const [markerEditor, setMarkerEditor] = useState(null);
  const [markerDelete, setMarkerDelete] = useState(null);
  // The tag/studio Info sheet: `{ kind, item }` from the long-press menu.
  const [entityInfo, setEntityInfo] = useState(null);
  // The global search page's query. App owns it because opening a performer
  // leaves the page for the Performers tab, and Back has to return to the same
  // results rather than an empty field.
  const [searchText, setSearchText] = useState('');
  // Surprise's transient status, and its one-request-at-a-time guard.
  const [surpriseNotice, flashSurprise] = useFlash();
  const surpriseBusy = useRef(false);

  const {
    builderOpen, setBuilderOpen, closeBuilder, applyWorkingFilter, clearWorkingFilter,
    saveBuiltFilter,
  } = useFilterBuilder({
    activeTab,
    filterMode,
    dataKey,
    controls,
    setControls,
    setFiltersEpoch,
    setSavedFilterEcho,
    activeFilter,
    mainFocus,
  });

  // Activating a tag, studio or gallery, and getting back from what it opened.
  const {
    filterOrigins, setFilterOrigins, activateFiltered, replaceOrigin, openShowroomListing,
    handleTagSelect, handleStudioSelect, handleGroupSelect, handleGallerySelect,
  } = useFilteredNavigation({ activeTab, dataKey, controls, changeTab, setControls });

  // What is open in front of a listing: scene detail, performer page or viewer.
  const {
    selectedPerformer,
    selectedScene,
    setSelectedScene,
    sceneOriginId,
    setSceneOriginId,
    clearedContinueIds,
    imageViewer,
    sceneCardFocus,
    handleVideoSelect,
    handleSceneClose,
    handleSceneActivityChange,
    handlePerformerSelect,
    handleShowroomPerformerSelect,
    handleSearchPerformerSelect,
    handleScenePerformerSelect,
    handlePerformerBack,
    handleImageSelect,
    openImageViewer,
    closeImageViewer,
  } = useDetailSelection({
    activeTab, dataKey, changeTab, filterOrigins, controls, setControls,
  });

  // The player, the long-press menu, and every way into both.
  const {
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
  } = usePlayback({
    activeTab,
    selectedScene,
    setSelectedScene,
    setSceneOriginId,
    mainFocus,
    sceneCardFocus,
    menuCardFocus,
  });

  // ── Chips and related rows on a scene detail ─────────────
  // The detail is not stacked over what a chip opens: it closes as the
  // destination is set, and Back lands on the card the chain started from
  // (a related row swaps the scene, not the origin). See the origin ids in
  // useAppBack and useDetailSelection.
  const sceneOriginFocusId = selectedScene
    ? (sceneOriginId || `video-${selectedScene.id}`)
    : null;

  // A chip on the Performers tab comes back to the performer grid, which holds
  // performer cards: the scene card named by `sceneOriginFocusId` is not there.
  // The gallery chip already names the performer for this case.
  const sceneChipOriginFocusId = activeTab === 'performers' && selectedPerformer
    ? `performer-${selectedPerformer.id}`
    : sceneOriginFocusId;

  const sceneTagSelect = (tag) => {
    setSelectedScene(null);
    handleTagSelect(tag, sceneChipOriginFocusId);
  };

  const sceneStudioSelect = (studio) => {
    setSelectedScene(null);
    handleStudioSelect(studio, sceneChipOriginFocusId);
  };

  const sceneGroupSelect = (group) => {
    setSelectedScene(null);
    handleGroupSelect(group, sceneChipOriginFocusId);
  };

  const handleRelatedSceneSelect = (item) => {
    if (item) setSelectedScene(item);
  };

  useAppBack({
    activeTab,
    selectedPerformer,
    selectedScene,
    actionMenu,
    imageViewer,
    entityInfo,
    builderOpen,
    settingsOpen,
    playing: !!playSession,
    filterOrigins,
    changeTab,
    setFilterOrigins,
    setControls,
    mainFocus,
    setExitPromptOpen,
  });

  // ── Surprise ─────────────────────────────────────────────
  // One random scene through the active filter, search and chips. Focus is
  // remembered at the press, like Play: the fetch may outlive it.
  //
  // The answer is only worth opening if the screen that asked is still the
  // one on show. Refs carry the current state into the late callback: leaving
  // Scenes, raising the exit prompt or opening another player bumps the token,
  // and any overlay blocks the open, so a slow random query cannot mount a
  // playing video under Settings, a detail or a menu, or replace a session
  // the user started meanwhile.
  const surpriseToken = useRef(0);
  const surpriseState = useRef({});
  surpriseState.current = {
    activeTab,
    playing: !!playSession,
    blocked: exitPromptOpen || !!selectedScene || !!actionMenu || settingsOpen
      || builderOpen || !!imageViewer || !!entityInfo,
  };
  useEffect(() => {
    if (activeTab !== 'scenes') surpriseToken.current += 1;
  }, [activeTab]);
  useEffect(() => {
    if (exitPromptOpen) surpriseToken.current += 1;
  }, [exitPromptOpen]);
  useEffect(() => () => { surpriseToken.current += 1; }, []);

  const surpriseMe = () => {
    if (surpriseBusy.current) {
      flashSurprise('Still picking a scene…');
      return;
    }
    surpriseBusy.current = true;
    const token = ++surpriseToken.current;
    mainFocus.remember(document.activeElement);
    flashSurprise('Picking a scene…');
    fetchRandomVideo({ filter: activeObjectFilter, q: activeSearchQuery })
      .then(video => {
        const now = surpriseState.current;
        if (token !== surpriseToken.current
          || now.activeTab !== 'scenes' || now.blocked || now.playing) return;
        if (!video) {
          flashSurprise('No scene matches the current filter.');
          return;
        }
        openPlayer(queueOf(video, 0));
      })
      .catch(e => {
        if (token !== surpriseToken.current) return;
        flashSurprise(`Could not pick a scene: ${e.message}`);
      })
      .finally(() => { surpriseBusy.current = false; });
  };

  const previewMuted = settings.previewMuted;
  const togglePreviewMuted = () => {
    setSettings({ previewMuted: !previewMuted });
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    // Restore focus to whatever opened the panel; deferred so the panel's
    // DOM is gone first.
    mainFocus.restore();
  };

  const cancelExit = () => {
    setExitPromptOpen(false);
    // Same deferred restore as the other closes: drop the prompt's DOM first.
    mainFocus.restore();
  };

  // ── Marker edit / delete ─────────────────────────────────
  // Both start from the long-press menu, so the card it opened on is the
  // return target. A deleted card is gone, hence the fallback.
  const closeMarkerOverlay = () => {
    setMarkerEditor(null);
    setMarkerDelete(null);
    menuCardFocus.restore({ fallback: focusFirstControl });
  };

  const editMarkerFromMenu = (marker) => {
    dismissActionMenu();
    setMarkerEditor(marker);
  };

  const deleteMarkerFromMenu = (marker) => {
    dismissActionMenu();
    setMarkerDelete(marker);
  };

  // The open listing patches itself; the modal closes through onClose.
  const handleMarkerSaved = (saved) => {
    publishRowPatch('marker', saved.id, {
      title: saved.title,
      seconds: saved.seconds,
      primaryTag: saved.primaryTag?.name || null,
      primaryTagId: saved.primaryTag?.id || null,
    });
  };

  const handleMarkerDeleted = (marker) => {
    publishRowRemove('marker', marker.id);
  };

  // A search section's See-all hands its query to that tab. The query must
  // arrive with the tab's first fetch, hence `searchForTab`; the arrival rule
  // otherwise clears search as a term typed against another section. The
  // origin takes Back out of the full listing and back to the results.
  const openSearchListing = (tab, query, focusId) => {
    replaceOrigin({ tab: 'search', focusId, to: tab });
    setControls(prev => ({ ...prev, search: query, searchForTab: tab }));
    changeTab(tab);
  };

  // ── Performer hub ────────────────────────────────────────
  // The counts and tag chips on a performer page open filtered listings.
  // `restorePerformer` keeps the detail mounted while the spoke is active and
  // names the control Back returns to; see useDetailSelection.
  const performerCriterion = (performer) => ({
    performers: { modifier: 'INCLUDES', value: [{ id: performer.id, label: performer.name }] },
  });

  const openPerformerImages = (performer) => activateFiltered(
    performerCriterion(performer),
    performer.name,
    'performer-images',
    'images',
    performer,
  );

  const openPerformerGalleries = (performer) => activateFiltered(
    performerCriterion(performer),
    performer.name,
    'performer-galleries',
    'galleries',
    performer,
  );

  const openPerformerTag = (tag) => {
    if (!selectedPerformer) return;
    activateFiltered(
      { tags: { modifier: 'INCLUDES', value: [{ id: tag.id, label: tag.name }] } },
      tag.name,
      `performer-tag-${tag.id}`,
      'scenes',
      selectedPerformer,
    );
  };

  // One dispatcher, not one `onSelect` per section: one `<EntityPage>` draws
  // every browse section and cannot know which, so the tab decides here.
  //
  // Stable between renders: it is the `onSelect` of every memoised entity
  // card, and a fresh identity on an unrelated App render would re-render the
  // whole grid. Every branch it calls is stable for the same reason.
  const handleEntitySelect = useCallback((item, index, items) => {
    switch (activeTab) {
      case 'tags':      return handleTagSelect(item);
      case 'studios':   return handleStudioSelect(item);
      case 'groups':    return handleGroupSelect(item);
      case 'galleries': return handleGallerySelect(item);
      case 'images':    return handleImageSelect(item, index, items);
      default:          return undefined;
    }
  }, [activeTab, handleTagSelect, handleStudioSelect, handleGroupSelect, handleGallerySelect, handleImageSelect]);

  // ── The long-press menu's viewer entries ─────────────────
  // The menu is cleared *without* its restore: the viewer takes focus on mount
  // and owns the return trip, so restoring to the card first would put focus
  // on the grid for a frame. The card is handed to the viewer instead.
  const menuReturnEl = () => menuCardFocus.targetRef.current;

  const openImageViewerFromMenu = (descriptor) => {
    dismissActionMenu();
    openImageViewer({ ...descriptor, restoreEl: menuReturnEl() });
  };

  const openGalleryFromMenu = (gallery) => {
    dismissActionMenu();
    // Same destination as Enter on the card: the Images tab, filtered to this
    // gallery. The tab change closes the menu's page context.
    handleGallerySelect(gallery);
  };

  const openGallerySlideshow = (gallery, { shuffle = false } = {}) => {
    dismissActionMenu();
    openImageViewer({
      gallery,
      shuffle,
      autoPlay: true,
      restoreEl: menuReturnEl(),
    });
  };

  // ── The entity Info sheet ────────────────────────────────
  // Read-only and opened from the menu, so the card the menu remembered is the
  // return target. The menu is dismissed without its restore: the sheet's panel
  // takes focus on mount and would otherwise be fighting the grid for it.
  const openEntityInfoFromMenu = (item, kind) => {
    dismissActionMenu();
    setEntityInfo({ kind, item });
  };

  const closeEntityInfo = () => {
    setEntityInfo(null);
    menuCardFocus.restore({ fallback: focusFirstControl });
  };

  // Same destination as Enter on the card; the tab change is what closes the
  // menu's page context.
  const filterEntityFromMenu = (item, kind) => {
    dismissActionMenu();
    switch (kind) {
      case 'tag': return handleTagSelect(item);
      case 'studio': return handleStudioSelect(item);
      case 'group': return handleGroupSelect(item);
      case 'gallery': return handleGallerySelect(item);
      default: return undefined;
    }
  };

  // A count in the info sheet opens that listing. One criterion serves every
  // target: `tags` is a field on all six filter types, `studios` on the four a
  // studio offers, `groups` on scenes/performers and `galleries` on images and
  // scenes. The sheet closes without restoring its card focus: the tab change
  // is the move, and Back returns to the card through the origin recorded here.
  const filterFromEntityInfo = (kind, item, target) => {
    // A gallery is titled, not named; both feed the stored entry's label.
    const label = item.name ?? item.title ?? '';
    const filter = kind === 'gallery' && target === 'performers'
      ? galleryPerformersFilter(item)
      : { [ENTITY_FILTER_FIELD[kind]]: { modifier: 'INCLUDES', value: [{ id: item.id, label }] } };
    setEntityInfo(null);
    activateFiltered(filter, label, `${kind}-${item.id}`, target);
  };

  return (
    <div className={styles.app} data-app-shell="">
      <h1 className="sr-only">StashZen</h1>

      <NavRail
        activeTab={activeTab}
        onTabChange={changeTab}
        onOpenSettings={() => {
          mainFocus.remember(document.activeElement);
          setSettingsOpen(true);
        }}
        hasUpdate={!!updateCheck.availableVersion}
      />

      {/* The rail is fixed; the top bar sits above the page in the content
          column rather than beside the nav. */}
      <div className={styles.content}>

        {/* Hidden on Home (the showroom has no sort, filter or search) and on
            a performer detail page, which renders its own scoped panel. */}
        {config?.showControls !== false
          && !(activeTab === 'performers' && selectedPerformer) && (
          <ControlsPanel
            controls={controls}
            activeTab={activeTab}
            onChange={(patch) => updateControls(patch, savedFilters)}
            modeOptions={config.modeOptions}
            mode={activeMode}
            onModeChange={setActiveMode}
            sortGroups={visibleSortGroups(config?.sortGroups, serverVersion)}
            showOrder={config.showOrder}
            showGridSize={config.showGridSize
              && activeMode !== 'carousel' && activeMode !== 'coverflow' && activeMode !== 'list'}
            filterOptions={filterOptions}
            onBuildFilter={filterMode ? () => {
              // Opening the builder pulls focus into its dialog and closing
              // drops the cursor to <body>. Remember the Build control, which
              // stays mounted underneath, for closeBuilder to restore.
              mainFocus.remember(document.activeElement);
              setBuilderOpen(true);
            } : null}
            showSearch={config.showSearch}
            previewMuted={previewMuted}
            onMuteToggle={togglePreviewMuted}
            quickFilterOptions={config.quickFilters || []}
            quickFilters={controls.quickFilters || []}
            onQuickFilterToggle={toggleQuickFilter}
            onSurprise={activeTab === 'scenes' ? surpriseMe : null}
            surpriseNotice={surpriseNotice}
          />
        )}

        <TabContent
          activeTab={activeTab}
          dataKey={dataKey}
          tabEpoch={tabEpoch}
          mode={activeMode}
          controls={controls}
          objectFilter={activeObjectFilter}
          searchQuery={activeSearchQuery}
          clearedSceneIds={clearedContinueIds}
          selectedPerformer={selectedPerformer}
          onVideoSelect={handleVideoSelect}
          onVideoLongPress={handleVideoLongPress}
          onStudioSelect={handleStudioSelect}
          onShowroomPerformerSelect={handleShowroomPerformerSelect}
          onPerformerSelect={handlePerformerSelect}
          onGallerySelect={handleGallerySelect}
          onSeeAll={openShowroomListing}
          onMarkerSelect={handleMarkerSelect}
          onMarkerLongPress={handleMarkerLongPress}
          onPerformerBack={handlePerformerBack}
          onPerformerImages={openPerformerImages}
          onPerformerGalleries={openPerformerGalleries}
          onPerformerTagSelect={openPerformerTag}
          previewMuted={previewMuted}
          onMuteToggle={togglePreviewMuted}
          onEntitySelect={handleEntitySelect}
          onEntityLongPress={handleEntityLongPress}
          searchText={searchText}
          onSearchQueryChange={setSearchText}
          onSearchPerformerSelect={handleSearchPerformerSelect}
          onSearchTagSelect={handleTagSelect}
          onSearchStudioSelect={handleStudioSelect}
          onSearchGroupSelect={handleGroupSelect}
          onSearchGallerySelect={handleGallerySelect}
          onSearchImageSelect={handleImageSelect}
          onSearchSeeAll={openSearchListing}
        />
      </div>

      <AppOverlays
        serverVersion={serverVersion}
        sceneDetail={{
          scene: selectedScene,
          onClose: handleSceneClose,
          onPlay: handleScenePlay,
          onPlayAt: playSceneAt,
          onActivityChange: handleSceneActivityChange,
          // A gallery chip leaves for the Images tab filtered to this gallery;
          // the tab change closes this page (useDetailSelection's effect), so
          // that is all it does.
          // Opened on the Performers tab itself, the performer is the card Back
          // can focus: the page closes with the tab and has no video cards. On
          // a hub spoke the origin tab is Scenes, whose cards are `video-`;
          // naming the performer there would leave Back polling for a card
          // that tab never has.
          onGallerySelect: (gallery, sceneId) => handleGallerySelect(
            gallery,
            sceneId,
            activeTab === 'performers' && selectedPerformer
              ? `performer-${selectedPerformer.id}` : null,
          ),
          onTagSelect: sceneTagSelect,
          onStudioSelect: sceneStudioSelect,
          onGroupSelect: sceneGroupSelect,
          onPerformerSelect: (performer) => selectedScene
            && handleScenePerformerSelect(selectedScene, performer),
          onRelatedSceneSelect: handleRelatedSceneSelect,
          // 0.32+ only; the extra request is skipped on older servers.
          showProductionDate: supportsCapability(serverVersion, 'productionDate'),
        }}
        actionMenu={{
          menu: actionMenu,
          openPlayer,
          onDetails: handleMenuDetails,
          openImageViewer: openImageViewerFromMenu,
          openGallery: openGalleryFromMenu,
          openGallerySlideshow,
          onEditMarker: editMarkerFromMenu,
          onDeleteMarker: deleteMarkerFromMenu,
          onInfo: openEntityInfoFromMenu,
          onFilterEntity: filterEntityFromMenu,
          onClose: closeActionMenu,
        }}
        info={{ entity: entityInfo, onClose: closeEntityInfo, onFilter: filterFromEntityInfo }}
        markerEditor={{
          marker: markerEditor,
          onClose: closeMarkerOverlay,
          onSaved: handleMarkerSaved,
          onDeleted: handleMarkerDeleted,
        }}
        markerDelete={{
          marker: markerDelete,
          onClose: closeMarkerOverlay,
          onDeleted: handleMarkerDeleted,
        }}
        imageViewer={{
          viewer: imageViewer,
          onClose: closeImageViewer,
        }}
        player={{
          session: playSession,
          onClose: handlePlayerClose,
          onActivityChange: handleSceneActivityChange,
          onSceneChange: handlePlayerSceneChange,
        }}
        builder={{
          open: builderOpen,
          filterType: config.filterType,
          serverVersion,
          tab: activeTab,
          // The user's filter without the chips: see combineQuickFilters.
          initial: baseObjectFilter,
          initialName: activeFilter?.name || '',
          onApply: applyWorkingFilter,
          onSave: saveBuiltFilter,
          onClear: clearWorkingFilter,
          onClose: closeBuilder,
        }}
        settings={{ open: settingsOpen, onClose: closeSettings }}
        exitPrompt={{ open: exitPromptOpen, onCancel: cancelExit }}
      />
    </div>
  );
}
