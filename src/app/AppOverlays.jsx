/**
 * AppOverlays, the stack App draws over the pages.
 *
 * Every overlay is a sibling of the content column, not a child of the page
 * that opened it, because each is opened from several pages and must outlive
 * the listing underneath. The sibling order is the stacking order; the
 * comments below record why.
 *
 * Each prop group is `{ open/record, ...handlers }`; nothing is decided here.
 */

import { lazy, Suspense } from 'react';
import ActionMenu from '../components/ActionMenu.jsx';
import EntityInfoOverlay from '../components/EntityInfoOverlay.jsx';
import MarkerModal from '../components/MarkerModal.jsx';
import MarkerDeletePrompt from '../components/MarkerDeletePrompt.jsx';
import PlayerErrorBoundary from '../components/PlayerErrorBoundary.jsx';
import OverlayGate from '../components/OverlayGate.jsx';
import ExitPrompt from '../components/ExitPrompt.jsx';
import { buildActionMenu } from '../utils/actionMenus.js';

// The five heaviest overlays are their own chunks. None of them can be open on
// the first screen, and together they are the bulk of what a Live launch would
// otherwise parse and execute before the grid appears. The small overlays
// above stay eager: a chunk round trip would cost more than their parse.
//
// Each sits in its own boundary, so opening one hides nothing that is already
// on screen (a single boundary would blank the detail page under a player that
// is still loading), and the underlying page stays visible until the chunk
// lands. OverlayGate adds the scoped error boundary and the pending fallback
// that owns the keys; see its comment.
const SceneDetailPage = lazy(() => import('../pages/SceneDetailPage.jsx'));
const ImageViewer = lazy(() => import('../components/ImageViewer.jsx'));
const VideoPlayer = lazy(() => import('../components/VideoPlayer.jsx'));
const FilterBuilder = lazy(() => import('../components/FilterBuilder.jsx'));
const SettingsPanel = lazy(() => import('../components/SettingsPanel.jsx'));

export default function AppOverlays({
  sceneDetail,
  actionMenu,
  info,
  markerEditor,
  markerDelete,
  imageViewer,
  player,
  builder,
  settings,
  exitPrompt,
}) {
  // Every long-press menu goes through one builder; see actionMenus.js for
  // which rows each kind has.
  const action = actionMenu.menu
    ? buildActionMenu(actionMenu.menu, {
      openPlayer: actionMenu.openPlayer,
      onDetails: actionMenu.onDetails,
      openImageViewer: actionMenu.openImageViewer,
      openGallery: actionMenu.openGallery,
      openGallerySlideshow: actionMenu.openGallerySlideshow,
      onEditMarker: actionMenu.onEditMarker,
      onDeleteMarker: actionMenu.onDeleteMarker,
      onInfo: actionMenu.onInfo,
      onFilterEntity: actionMenu.onFilterEntity,
    })
    : null;

  return (
    <>
      {/* Keyed on the scene id so opening a different scene remounts the page
          instead of carrying over its optimistic detail state. */}
      {sceneDetail.scene && (
        <OverlayGate onClose={sceneDetail.onClose}>
          <SceneDetailPage
            key={sceneDetail.scene.id}
            scene={sceneDetail.scene}
            onClose={sceneDetail.onClose}
            onPlay={sceneDetail.onPlay}
            onPlayAt={sceneDetail.onPlayAt}
            onActivityChange={sceneDetail.onActivityChange}
            onGallerySelect={sceneDetail.onGallerySelect}
            onTagSelect={sceneDetail.onTagSelect}
            onStudioSelect={sceneDetail.onStudioSelect}
            onPerformerSelect={sceneDetail.onPerformerSelect}
            onRelatedSceneSelect={sceneDetail.onRelatedSceneSelect}
          />
        </OverlayGate>
      )}

      {/* The menu, then the player, and the player on top, since Play
          closes the menu and opens it in the same press. */}
      {action && (
        <ActionMenu
          title={action.title}
          subtitle={action.subtitle}
          items={action.items}
          onClose={actionMenu.onClose}
        />
      )}

      {/* The tag/studio sheet. The menu closes as it opens, so this never
          stacks on the menu; it sits here only to outlive the listing. */}
      {info.entity && (
        <EntityInfoOverlay
          entity={info.entity}
          onClose={info.onClose}
          onFilter={info.onFilter}
        />
      )}

      {/* Keyed per marker: the form is uncontrolled, so a second marker must
          mount a fresh one rather than keep the first one's title. */}
      {markerEditor.marker && (
        <MarkerModal
          key={markerEditor.marker.id}
          marker={markerEditor.marker}
          sceneId={markerEditor.marker.scene?.id}
          sceneTitle={markerEditor.marker.scene?.title}
          duration={markerEditor.marker.scene?.durationSeconds || 0}
          defaultTag={{
            id: markerEditor.marker.primaryTagId,
            name: markerEditor.marker.primaryTag,
          }}
          onClose={markerEditor.onClose}
          onSaved={markerEditor.onSaved}
          onDeleted={markerEditor.onDeleted}
        />
      )}

      {markerDelete.marker && (
        <MarkerDeletePrompt
          marker={markerDelete.marker}
          onClose={markerDelete.onClose}
          onDeleted={markerDelete.onDeleted}
        />
      )}

      {/* Above the grid, below the player. It cannot be open while a video
          plays, so the order is a statement about intent, not a case that
          arises. */}
      {imageViewer.viewer && (
        <OverlayGate onClose={imageViewer.onClose}>
          <ImageViewer
            items={imageViewer.viewer.items}
            index={imageViewer.viewer.index}
            gallery={imageViewer.viewer.gallery}
            shuffle={imageViewer.viewer.shuffle}
            autoPlay={imageViewer.viewer.autoPlay}
            initialInfoOpen={imageViewer.viewer.infoOpen}
            onClose={imageViewer.onClose}
          />
        </OverlayGate>
      )}

      {player.session && (
        // Scoped boundary: a render error here closes the player and returns
        // to the screen underneath instead of taking the whole app down.
        <PlayerErrorBoundary onClose={player.onClose}>
          {/* Inside the boundary: a chunk that fails to load closes the
              player instead of leaving an empty screen over the grid. */}
          <Suspense fallback={null}>
            <VideoPlayer
              queue={player.session}
              onClose={player.onClose}
              onActivityChange={player.onActivityChange}
              onSceneChange={player.onSceneChange}
            />
          </Suspense>
        </PlayerErrorBoundary>
      )}

      {/* Below Settings and the exit prompt so a more recent intent is on
          top. It cannot open over a playing video: the action that opens it
          lives in the controls bar, which the player covers. */}
      {builder.open && (
        <OverlayGate onClose={builder.onClose}>
          <FilterBuilder
            filterType={builder.filterType}
            title={`Filter ${builder.tab}`}
            // Seeded from whatever is applied now, so "edit the current filter"
            // and "start from nothing" are the same gesture.
            initial={builder.initial}
            initialName={builder.initialName}
            onApply={builder.onApply}
            onSave={builder.onSave}
            onClose={builder.onClose}
          />
        </OverlayGate>
      )}

      {settings.open && (
        <OverlayGate onClose={settings.onClose}>
          <SettingsPanel onClose={settings.onClose} />
        </OverlayGate>
      )}

      {exitPrompt.open && <ExitPrompt onCancel={exitPrompt.onCancel} />}
    </>
  );
}
