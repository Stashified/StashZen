/**
 * AppOverlays — the stack App draws over the pages.
 *
 * Every overlay is a sibling of the content column, not a child of the page
 * that opened it, because each is opened from several pages and must outlive
 * the listing underneath. The order of the siblings is the stacking order,
 * and the comments below record why it is that order rather than another.
 *
 * Each prop group is `{ open/record, ...handlers }` — the state comes from
 * App's hooks, the handlers from the same places, and nothing is decided
 * here.
 */

import SceneDetailPage from '../pages/SceneDetailPage.jsx';
import ActionMenu from '../components/ActionMenu.jsx';
import ImageViewer from '../components/ImageViewer.jsx';
import VideoPlayer from '../components/VideoPlayer.jsx';
import PlayerErrorBoundary from '../components/PlayerErrorBoundary.jsx';
import FilterBuilder from '../components/FilterBuilder.jsx';
import SettingsPanel from '../components/SettingsPanel.jsx';
import ExitPrompt from '../components/ExitPrompt.jsx';
import { buildSceneMenuItems } from '../utils/sceneMenu.js';

export default function AppOverlays({
  sceneDetail,
  actionMenu,
  imageViewer,
  player,
  builder,
  settings,
  exitPrompt,
}) {
  return (
    <>
      {/* Keyed on the scene id so opening a different scene remounts the
          page instead of reusing the instance — otherwise its optimistic
          detail state would carry over from the previous scene. */}
      {sceneDetail.scene && (
        <SceneDetailPage
          key={sceneDetail.scene.id}
          scene={sceneDetail.scene}
          onClose={sceneDetail.onClose}
          onPlay={sceneDetail.onPlay}
          onPlayAt={sceneDetail.onPlayAt}
          onActivityChange={sceneDetail.onActivityChange}
        />
      )}

      {/* The menu, then the player — and the player on top, since Play
          closes the menu and opens it in the same press. */}
      {actionMenu.menu && (
        <ActionMenu
          title={actionMenu.menu.video.title}
          subtitle={actionMenu.menu.list?.total
            ? `${actionMenu.menu.index + 1} of ${actionMenu.menu.list.total} in this listing`
            : null}
          items={buildSceneMenuItems(actionMenu.menu, {
            openPlayer: actionMenu.openPlayer,
            onDetails: actionMenu.onDetails,
          })}
          onClose={actionMenu.onClose}
        />
      )}

      {/* The image viewer, above the grid and below the player. It cannot be
          open while a video plays — it is opened from the Images tab and the
          player's action lives on a scene — so the order between these two is
          a statement about intent rather than a case that arises. */}
      {imageViewer.viewer && (
        <ImageViewer
          items={imageViewer.viewer.items}
          index={imageViewer.viewer.index}
          onIndexChange={imageViewer.onIndexChange}
          onClose={imageViewer.onClose}
        />
      )}

      {player.session && (
        // Scoped boundary: a render error here closes the player and returns
        // to the screen underneath instead of taking the whole app down.
        <PlayerErrorBoundary onClose={player.onClose}>
          <VideoPlayer
            queue={player.session}
            onClose={player.onClose}
            onActivityChange={player.onActivityChange}
          />
        </PlayerErrorBoundary>
      )}

      {/* The builder sits below Settings and the exit prompt in the tree so
          that, should both ever be open, the more recent intent is on top.
          It cannot open over a playing video — the action that opens it lives
          in the controls bar, which the player covers. */}
      {builder.open && (
        <FilterBuilder
          filterType={builder.filterType}
          title={`Filter ${builder.tab}`}
          // Seeded from whatever is applied now, so "edit the current filter"
          // and "start from nothing" are the same gesture: the rows are there
          // if there were any, and empty if there were not.
          initial={builder.initial}
          initialName={builder.initialName}
          onApply={builder.onApply}
          onSave={builder.onSave}
          onClose={builder.onClose}
        />
      )}

      {settings.open && <SettingsPanel onClose={settings.onClose} />}

      {exitPrompt.open && <ExitPrompt onCancel={exitPrompt.onCancel} />}
    </>
  );
}
