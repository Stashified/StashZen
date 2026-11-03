/**
 * useAppBack: App's place in the layered Back stack.
 *
 * The order of the checks is the user's mental stack: close what is on
 * screen, then step back out of where you are, then leave the app. The
 * overlays above close themselves on the capture phase; these checks are
 * backstops plus the two decisions App owns, a filtered listing's origin and
 * the exit prompt.
 *
 * Must stay the only caller of `useKeyHandler` in App, so its registration
 * position relative to App's other effects does not move.
 */

import { useKeyHandler } from '../hooks/useKeyHandler.js';
import { focusOriginCard } from '../utils/focus.js';
import { restoreControls } from './controlRestore.js';

export function useAppBack({
  activeTab,
  selectedPerformer,
  selectedScene,
  actionMenu,
  imageViewer,
  entityInfo,
  builderOpen,
  settingsOpen,
  playing,
  filterOrigins,
  changeTab,
  setFilterOrigins,
  setControls,
  mainFocus,
  setExitPromptOpen,
}) {
  useKeyHandler({
    onBack: () => {
      // Performer detail: handled by the page's own Back handler.
      if (activeTab === 'performers' && selectedPerformer) return;
      // Scene detail: same; its own handler stops propagation, so this only
      // stops a slipped-through Back raising the exit prompt behind it.
      if (selectedScene) return;
      // Long-press menu: closes itself on the capture phase; without this a
      // Back that got through would raise the exit prompt on top of it.
      if (actionMenu) return;
      // Image viewer: same again, it closes itself on the capture phase too.
      if (imageViewer) return;
      // Tag/studio sheet: same, its capture handler closes it.
      if (entityInfo) return;
      // Builder, Settings and the player close themselves on the capture
      // phase too. The backstop matters while their chunk is loading, when
      // only the gate's fallback is up: without it Back raised the exit prompt
      // over a screen the user had just asked for.
      if (builderOpen || settingsOpen || playing) return;
      // Back out of a listing a tag, studio or gallery opened unwinds one
      // level: the section it came from, the filter that section had before
      // the activation, and focus back on the pressed card. Checked against
      // `activeTab` because a stale origin would send the user to a section
      // they did not come from; the arrival rule clears the stack when the
      // filtered tab is left.
      const top = filterOrigins[filterOrigins.length - 1];
      if (top && top.to === activeTab) {
        const { tab, focusId, filter } = top;
        setFilterOrigins(prev => prev.slice(0, -1));
        // Same-tab Back is a focus move, not a reload. Bumping tabEpoch here
        // remounted the listing, and the restore landed on a card the remount
        // was about to replace, so Back from a group chip focused the first
        // card. A changed filter still resets the listing through its request
        // key, so nothing needs the remount.
        const sameTab = tab === activeTab;
        if (!sameTab) {
          changeTab(tab);
          // The snapshot carries search, chips and sort too; the marker tells
          // the arrival rule this visit is a return, not a fresh tab.
          restoreControls(setControls, filter, tab);
        } else {
          setControls(prev => ({ ...prev, ...filter }));
        }
        // The restored filter commits on this render; starting the restore
        // before that would find the outgoing listing's cards. A cross-tab
        // restore waits for the mount anyway, so only the same-tab case defers.
        focusOriginCard(tab, focusId, { defer: sameTab });
        return;
      }
      // Top-level tab: confirm before exit. Remember what had focus so
      // cancelling returns the user there; otherwise focus stays on the
      // unmounted prompt button.
      mainFocus.remember(document.activeElement);
      setExitPromptOpen(true);
    },
  });
}
