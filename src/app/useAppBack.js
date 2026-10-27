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
import { focusByIdWhenReady, focusFirstControl } from '../utils/focus.js';

export function useAppBack({
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
      // Back out of a listing a tag, studio or gallery opened returns to the
      // section it came from, filter dropped and focus back on the pressed
      // card. Checked against `activeTab` because a stale origin would send
      // the user to a section they did not come from; the arrival rule clears
      // it when the filtered tab is left.
      if (filterOrigin && filterOrigin.to === activeTab) {
        const { tab, focusId } = filterOrigin;
        setFilterOrigin(null);
        changeTab(tab);
        setControls(prev => ({
          ...prev,
          workingFilter: null,
          workingFilterFor: null,
          workingFilterLabel: null,
          filterId: null,
        }));
        // The origin section must re-render before its cards exist to focus,
        // and its listing may still be in flight, hence the retry. A scene
        // opened from Home has no `video-` card there: the same scene sits on
        // a showroom shelf under another prefix. Try those too, then the first
        // control, so a dead id never leaves the cursor on <body>.
        const ids = [focusId];
        const scene = /^video-(.+)$/.exec(String(focusId));
        if (scene && tab === 'home') {
          ids.push(
            `showroom-recent-scenes-video-${scene[1]}`,
            `showroom-continue-video-${scene[1]}`,
          );
        }
        focusByIdWhenReady(ids, { fallback: focusFirstControl });
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
