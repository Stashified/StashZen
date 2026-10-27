/**
 * Root component: the active tab, the per-tab controls and the overlay stack.
 * The state behind them lives in `app/use*.js`; the page switch and overlays
 * in `app/TabContent.jsx` and `app/AppOverlays.jsx`.
 */

import { useState } from 'react';
import NavRail from './components/NavRail.jsx';
import ControlsPanel from './components/ControlsPanel.jsx';
import { useRestoreFocus } from './hooks/useRestoreFocus.js';
import styles from './App.module.css';
import { useSettings, setSettings, dataSourceKey } from './utils/settings.js';
import { useAutoUpdateCheck } from './hooks/useAutoUpdateCheck.js';
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
  // Subscribing remounts the data tree on Test/Live or URL/key change, so
  // in-flight fetches and state from the previous source are discarded.
  const settings = useSettings();
  const dataKey = dataSourceKey(settings);

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
    activeObjectFilter,
    activeSearchQuery,
    filterOptions,
    setFiltersEpoch,
    setSavedFilterEcho,
  } = useActiveFilter({ controls, filterMode, dataKey });

  // Focus restore targets: `mainFocus` is shared by builder, player, settings
  // and exit; the card targets belong to the overlay hooks.
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
    activeFilter,
    mainFocus,
  });

  // Activating a tag, studio or gallery, and getting back from what it opened.
  const {
    filterOrigin, setFilterOrigin, openShowroomListing,
    handleTagSelect, handleStudioSelect, handleGallerySelect,
  } = useFilteredNavigation({ activeTab, dataKey, changeTab, setControls });

  // What is open in front of a listing: scene detail, performer page or viewer.
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
    openImageViewer,
    closeImageViewer,
  } = useDetailSelection({ activeTab, dataKey, changeTab });

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
    // Restore focus to whatever opened the panel; deferred so the panel's
    // DOM is gone first.
    mainFocus.restore();
  };

  const cancelExit = () => {
    setExitPromptOpen(false);
    // Same deferred restore as the other closes: drop the prompt's DOM first.
    mainFocus.restore();
  };

  // One dispatcher, not four `onSelect` props: one `<EntityPage>` draws all
  // four sections and cannot know which, so the tab decides here.
  const handleEntitySelect = (item, index, items) => {
    switch (activeTab) {
      case 'tags':      return handleTagSelect(item);
      case 'studios':   return handleStudioSelect(item);
      case 'galleries': return handleGallerySelect(item);
      case 'images':    return handleImageSelect(item, index, items);
      default:          return undefined;
    }
  };

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
            onChange={(patch) => updateControls(patch, savedFilters)}
            modeOptions={config.modeOptions}
            mode={activeMode}
            onModeChange={setActiveMode}
            sortGroups={config.sortGroups}
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
          previewMuted={previewMuted}
          onMuteToggle={togglePreviewMuted}
          onEntitySelect={handleEntitySelect}
          onEntityLongPress={handleEntityLongPress}
        />
      </div>

      <AppOverlays
        sceneDetail={{
          scene: selectedScene,
          onClose: handleSceneClose,
          onPlay: handleScenePlay,
          onPlayAt: playSceneAt,
          onActivityChange: handleSceneActivityChange,
          // A gallery chip leaves for the Galleries tab; the tab change closes
          // this page (useDetailSelection's effect), so that is all it does.
          onGallerySelect: handleGallerySelect,
        }}
        actionMenu={{
          menu: actionMenu,
          openPlayer,
          onDetails: handleMenuDetails,
          openImageViewer: openImageViewerFromMenu,
          openGallery: openGalleryFromMenu,
          openGallerySlideshow,
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
          onSceneChange: handlePlayerSceneChange,
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
