/**
 * App.jsx — Root component
 *
 * Owns the active tab, the per-tab controls and the overlay stack, and
 * composes the rail, the control bar, the pages and the overlays. The state
 * and handlers behind that composition live in `app/use*.js`; the page
 * switch in `app/TabContent.jsx`; the overlay stack in `app/AppOverlays.jsx`;
 * static tab configuration in `app/tabConfig.js`.
 */

import { useState } from 'react';
import NavRail from './components/NavRail.jsx';
import ControlsPanel from './components/ControlsPanel.jsx';
import { useRestoreFocus } from './hooks/useRestoreFocus.js';
import styles from './App.module.css';
import { useSettings, setSettings, dataSourceKey } from './utils/settings.js';
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

export default function App() {
  // Subscribe to runtime settings — used to remount the data tree on
  // Test/Live switch (and on URL/key change in Live mode) so any
  // in-flight fetches and cached state from the previous source are
  // discarded cleanly.
  const settings = useSettings();
  const dataKey = dataSourceKey(settings);

  const { activeTab, tabEpoch, changeTab } = useTabNavigation();

  // The controls bar's state, the view mode and the grid-column count — and
  // the render-phase rules that decide what survives a tab or source change.
  const {
    controls, setControls, updateControls, activeMode, setActiveMode,
  } = useListingControls({ activeTab, dataKey, settings });

  // Saved filters for the active tab.
  const config = TAB_CONTROL_CONFIG[activeTab];
  const filterMode = config?.filterMode || null;

  // The saved-filter list, the current selection, and the three values the
  // listing tabs fetch with.
  const {
    savedFilters,
    activeFilter,
    activeObjectFilter,
    activeSearchQuery,
    filterOptions,
    setFiltersEpoch,
    setSavedFilterEcho,
  } = useActiveFilter({ controls, filterMode, dataKey });

  // Focus restore targets. `mainFocus` is the shared one (builder, player,
  // settings, exit); the card targets belong to the overlay hooks.
  const mainFocus = useRestoreFocus();
  const menuCardFocus = useRestoreFocus();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exitPromptOpen, setExitPromptOpen] = useState(false);

  const {
    builderOpen, setBuilderOpen, closeBuilder, applyWorkingFilter, saveBuiltFilter,
  } = useFilterBuilder({
    activeTab,
    filterMode,
    dataKey,
    controls,
    setControls,
    setFiltersEpoch,
    setSavedFilterEcho,
    mainFocus,
  });

  // Activating a tag, studio or gallery, and getting back from what it opened.
  const {
    filterOrigin, setFilterOrigin, openShowroomListing,
    handleTagSelect, handleStudioSelect, handleGallerySelect,
  } = useFilteredNavigation({ activeTab, dataKey, changeTab, setControls });

  // What is open *in front of* a listing: a scene detail page, a performer
  // page, or the image viewer.
  const {
    selectedPerformer,
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
    handlePerformerBack,
    handleImageSelect,
    closeImageViewer,
  } = useDetailSelection({ activeTab, dataKey, changeTab });

  // The player, the long-press menu, and every way into both.
  const {
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
  } = usePlayback({
    selectedScene,
    setSelectedScene,
    mainFocus,
    sceneCardFocus,
    menuCardFocus,
  });

  useAppBack({
    activeTab,
    selectedPerformer,
    selectedScene,
    actionMenu,
    imageViewer,
    filterOrigin,
    changeTab,
    setFilterOrigin,
    setControls,
    mainFocus,
    setExitPromptOpen,
  });

  const previewMuted = settings.previewMuted;
  const togglePreviewMuted = () => {
    setSettings({ previewMuted: !previewMuted });
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    // Restore focus to whatever opened the panel (the hamburger,
    // typically). Deferred so the panel's DOM is gone first.
    mainFocus.restore();
  };

  const cancelExit = () => {
    setExitPromptOpen(false);
    // Same restore as the player/settings closes: defer a tick so
    // the prompt's DOM is gone before we hand focus back.
    mainFocus.restore();
  };

  // One dispatcher rather than four `onSelect` props, because the four sections
  // are served by one `<EntityPage>` and it has no idea which of them it is
  // drawing. Everything section-specific about a selection therefore has to be
  // decided here, where the tab is known.
  const handleEntitySelect = (item, index, items) => {
    switch (activeTab) {
      case 'tags':      return handleTagSelect(item);
      case 'studios':   return handleStudioSelect(item);
      case 'galleries': return handleGallerySelect(item);
      case 'images':    return handleImageSelect(item, index, items);
      default:          return undefined;
    }
  };

  return (
    <div className={styles.app}>
      <h1 className="sr-only">StashZen</h1>

      <NavRail
        activeTab={activeTab}
        onTabChange={changeTab}
        onOpenSettings={() => {
          mainFocus.remember(document.activeElement);
          setSettingsOpen(true);
        }}
      />

      {/* The rail is fixed; everything else lives in the content column, so
          the top bar (scene selection: filters, sort, search, view) sits
          above the page rather than beside the nav. */}
      <div className={styles.content}>

        {/* Hide the app-level ControlsPanel while on a performer detail
        page — that page renders its own scoped ControlsPanel — and on Home,
        which is the showroom: it has no sort, filter or search of its own.
        The listing tabs, Scenes first among them, still own the bar. */}
        {config?.showControls !== false
          && !(activeTab === 'performers' && selectedPerformer) && (
          <ControlsPanel
            controls={controls}
            onChange={(patch) => updateControls(patch, savedFilters)}
            modeOptions={config.modeOptions}
            mode={activeMode}
            onModeChange={setActiveMode}
            sortGroups={config.sortGroups}
            showOrder={config.showOrder}
            showGridSize={config.showGridSize
              && activeMode !== 'carousel' && activeMode !== 'coverflow' && activeMode !== 'list'}
            filterOptions={filterOptions}
            onBuildFilter={filterMode ? () => setBuilderOpen(true) : null}
            showSearch={config.showSearch}
            previewMuted={previewMuted}
            onMuteToggle={togglePreviewMuted}
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
          onPerformerBack={handlePerformerBack}
          previewMuted={previewMuted}
          onMuteToggle={togglePreviewMuted}
          onEntitySelect={handleEntitySelect}
        />
      </div>

      <AppOverlays
        sceneDetail={{
          scene: selectedScene,
          onClose: handleSceneClose,
          onPlay: handleScenePlay,
          onPlayAt: playSceneAt,
          onActivityChange: handleSceneActivityChange,
        }}
        actionMenu={{
          menu: actionMenu,
          openPlayer,
          onDetails: handleMenuDetails,
          onClose: closeActionMenu,
        }}
        imageViewer={{
          viewer: imageViewer,
          onIndexChange: (i) => setImageViewer(v => (v ? { ...v, index: i } : v)),
          onClose: closeImageViewer,
        }}
        player={{
          session: playSession,
          onClose: handlePlayerClose,
          onActivityChange: handleSceneActivityChange,
        }}
        builder={{
          open: builderOpen,
          filterType: config.filterType,
          tab: activeTab,
          initial: activeObjectFilter,
          initialName: activeFilter?.name || '',
          onApply: applyWorkingFilter,
          onSave: saveBuiltFilter,
          onClose: closeBuilder,
        }}
        settings={{ open: settingsOpen, onClose: closeSettings }}
        exitPrompt={{ open: exitPromptOpen, onCancel: cancelExit }}
      />
    </div>
  );
}
