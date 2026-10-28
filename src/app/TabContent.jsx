/**
 * TabContent, App's `<main>`: the page switch and the key that remounts it.
 *
 * A composition root, not a stateful component: everything it needs is passed
 * down as props and nothing here decides anything.
 */

import ShowroomPage from '../pages/ShowroomPage.jsx';
import SearchPage from '../pages/SearchPage.jsx';
import ScenesPage from '../pages/ScenesPage.jsx';
import PerformersPage from '../pages/PerformersPage.jsx';
import MarkersPage from '../pages/MarkersPage.jsx';
import EntityPage from '../pages/EntityPage.jsx';
import PerformerDetailPage from '../pages/PerformerDetailPage.jsx';
import { ENTITY_VIEWS } from './tabConfig.js';
import styles from '../App.module.css';

export default function TabContent({
  activeTab,
  dataKey,
  tabEpoch,
  mode,
  controls,
  objectFilter,
  searchQuery,
  clearedSceneIds,
  selectedPerformer,
  onVideoSelect,
  onVideoLongPress,
  onStudioSelect,
  onShowroomPerformerSelect,
  onPerformerSelect,
  onGallerySelect,
  onSeeAll,
  onMarkerSelect,
  onMarkerLongPress,
  onPerformerBack,
  previewMuted,
  onMuteToggle,
  onEntitySelect,
  onEntityLongPress,
  searchText,
  onSearchQueryChange,
  onSearchPerformerSelect,
  onSearchTagSelect,
  onSearchStudioSelect,
  onSearchSeeAll,
}) {
  return (
    /* Keying main remounts the active page on a data-source change (Test↔Live,
        endpoint/key change) and on a press of the rail's current row
        (`tabEpoch`, the in-place reload; see `changeTab`). In-flight fetches
        are dropped; list caches are partitioned by source and, on a reload,
        cleared by `changeTab` before this remount. */
    <main key={`${dataKey}\u0000${tabEpoch}`} className={styles.main} role="main">
      {activeTab === 'home'       && <ShowroomPage   onVideoSelect={onVideoSelect} onVideoLongPress={onVideoLongPress} onStudioSelect={onStudioSelect} onPerformerSelect={onShowroomPerformerSelect} onGallerySelect={onGallerySelect} onSeeAll={onSeeAll} clearedSceneIds={clearedSceneIds} />}
      {activeTab === 'search'     && <SearchPage     query={searchText} onQueryChange={onSearchQueryChange} onSceneSelect={onVideoSelect} onPerformerSelect={onSearchPerformerSelect} onTagSelect={onSearchTagSelect} onStudioSelect={onSearchStudioSelect} onSeeAll={onSearchSeeAll} />}
      {activeTab === 'scenes'     && <ScenesPage     mode={mode} controls={controls} objectFilter={objectFilter} searchQuery={searchQuery} onVideoSelect={onVideoSelect} onVideoLongPress={onVideoLongPress} />}
      {activeTab === 'performers' && (
        selectedPerformer
          ? <PerformerDetailPage
              performer={selectedPerformer}
              onBack={onPerformerBack}
              onVideoSelect={onVideoSelect}
              // The performer's grid is a scene listing like any other, so
              // the action menu and queue are scoped to this listing.
              onVideoLongPress={onVideoLongPress}
              previewMuted={previewMuted}
              onMuteToggle={onMuteToggle}
            />
          : <PerformersPage mode={mode} controls={controls} objectFilter={objectFilter} searchQuery={searchQuery} onPerformerSelect={onPerformerSelect} />
      )}
      {activeTab === 'markers'    && <MarkersPage    mode={mode} controls={controls} objectFilter={objectFilter} searchQuery={searchQuery} onMarkerSelect={onMarkerSelect} onMarkerLongPress={onMarkerLongPress} />}
      {/* The four browse-only sections share one page, so this is a lookup
          rather than four more lines.

          **`key={activeTab}` is load-bearing.** The three tabs above move
          between different component types: ScenesPage, PerformersPage,
          MarkersPage, so React unmounts one and mounts the next. These four
          are one type in one position, so without a key React *reconciles*
          EntityPage across a tab switch: `EntityGrid` stays mounted,
          `usePagedList` keeps its `items`, and its reset effect does not
          re-run because `[sort, order, objectFilter, searchQuery]` do not
          change from Tags to Studios. The result is Studios drawn with the
          Tags tab's rows and no `findStudios` ever sent. */}
      {ENTITY_VIEWS[activeTab] && (
        <EntityPage
          key={activeTab}
          view={ENTITY_VIEWS[activeTab]}
          mode={mode}
          controls={controls}
          objectFilter={objectFilter}
          searchQuery={searchQuery}
          onSelect={onEntitySelect}
          onLongPress={onEntityLongPress}
        />
      )}
    </main>
  );
}
