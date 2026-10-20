/**
 * TabContent — App's `<main>`: the page switch and the key that remounts it.
 *
 * A composition root, not a stateful component. It exists so that App's body
 * reads as the app's shape — rail, controls, page, overlays — rather than as a
 * seven-branch switch. Everything it needs is passed down as props; nothing
 * here decides anything.
 */

import ShowroomPage from '../pages/ShowroomPage.jsx';
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
}) {
  return (
    /* Keying main forces a clean remount of the active page in two
        cases: a data-source change (Test↔Live, or endpoint/key change),
        and a press on the rail row that is already current (`tabEpoch`,
        the in-place reload — see `changeTab`). All in-flight fetches are
        dropped; the module-scoped list caches are partitioned by source
        and, on a reload, cleared by `changeTab` before this remount. */
    <main key={`${dataKey}\u0000${tabEpoch}`} className={styles.main} role="main">
      {activeTab === 'home'       && <ShowroomPage   onVideoSelect={onVideoSelect} onVideoLongPress={onVideoLongPress} onStudioSelect={onStudioSelect} onPerformerSelect={onShowroomPerformerSelect} onGallerySelect={onGallerySelect} onSeeAll={onSeeAll} clearedSceneIds={clearedSceneIds} />}
      {activeTab === 'scenes'     && <ScenesPage     mode={mode} controls={controls} objectFilter={objectFilter} searchQuery={searchQuery} onVideoSelect={onVideoSelect} onVideoLongPress={onVideoLongPress} />}
      {activeTab === 'performers' && (
        selectedPerformer
          ? <PerformerDetailPage
              performer={selectedPerformer}
              onBack={onPerformerBack}
              onVideoSelect={onVideoSelect}
              // The performer's grid is a scene listing like any other: the
              // action menu (play from here, details) and the queue it builds
              // are scoped to this listing, which is what the card hands up.
              onVideoLongPress={onVideoLongPress}
              previewMuted={previewMuted}
              onMuteToggle={onMuteToggle}
            />
          : <PerformersPage mode={mode} controls={controls} objectFilter={objectFilter} searchQuery={searchQuery} onPerformerSelect={onPerformerSelect} />
      )}
      {activeTab === 'markers'    && <MarkersPage    mode={mode} controls={controls} objectFilter={objectFilter} searchQuery={searchQuery} onMarkerSelect={onMarkerSelect} onMarkerLongPress={onMarkerLongPress} />}
      {/* The four browse-only sections share one page, so this is a lookup
          rather than four more lines: a tab with no descriptor in the map
          simply does not render here, which is the right answer for the
          three tabs above.

          **`key={activeTab}` is load-bearing, and this is not a caching
          hint.** The three tabs above move between *different component
          types* — ScenesPage, PerformersPage, MarkersPage — so React unmounts
          one and mounts the next. These four are one type in one position,
          so without a key React *reconciles* EntityPage across a tab
          switch: `EntityGrid` stays mounted, `usePagedList` keeps its
          `items`, and its reset effect does not re-run because its deps are
          `[sort, order, objectFilter, searchQuery]` — and none of those
          change when you go from Tags to Studios. The visible result, seen
          on the harness before this line existed: the Studios tab drawn
          with the Tags tab's rows, under Studios' own prefixes, with no
          `findStudios` ever sent. The fixture cannot catch it by id —
          `listing_tag(1)` and `listing_studio(1)` are both `id: "1"` — so
          it is S1's content assertion that goes red, not its card count. */}
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
