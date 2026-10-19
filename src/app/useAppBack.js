/**
 * useAppBack — App's place in the layered Back stack.
 *
 * The order of the checks is the user's mental stack: close what is on
 * screen, then step back out of where you are, then leave the app. Every
 * overlay above this one closes itself on the capture phase; the checks here
 * are the backstops for a Back that slipped through, and the two real
 * decisions App owns — a filtered listing's origin, and the exit prompt.
 *
 * This must stay the only caller of `useKeyHandler` in App, so its
 * registration position relative to the rest of App's effects does not move.
 */

import { useKeyHandler } from '../hooks/useKeyHandler.js';
import { focusByIdWhenReady } from '../utils/focus.js';

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
      // Scene detail: same. Its own handler stops propagation, so this is
      // only a backstop — but without it a Back that somehow slipped
      // through would raise the exit prompt *behind* an open overlay.
      if (selectedScene) return;
      // Long-press menu: it closes itself on the capture phase, so this is
      // the same backstop the detail page has — without it a Back that got
      // through would raise the exit prompt on top of the menu.
      if (actionMenu) return;
      // Image viewer: same again. It closes itself on the capture phase too.
      if (imageViewer) return;
      // Back out of a listing a tag, studio or gallery opened returns to the
      // section it came from, with the filter dropped and focus back on the
      // card that was pressed. This is *before* the exit prompt and after the
      // overlay backstops, which is the order the user's mental stack has it
      // in: close what is on screen, then step back out of where you are, then
      // leave the app.
      //
      // Checked against `activeTab` rather than trusted, because a stale origin
      // would send the user to a section they did not come from. The arrival
      // rule clears it whenever the filtered tab is left, so a stale one
      // should not exist — this is the cheap half of that guarantee.
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
        // The origin section's grid has to re-render before its cards exist to
        // focus, and its listing may still be in flight — hence the retry
        // rather than a fixed delay. See focusByIdWhenReady.
        focusByIdWhenReady(focusId);
        return;
      }
      // Top-level tab: confirm before exit. Remember what had focus so
      // cancelling puts the user back where they were — without this,
      // focus stayed on the (now unmounted) prompt button and the
      // remote's Left/Right had no element to move from.
      mainFocus.remember(document.activeElement);
      setExitPromptOpen(true);
    },
  });
}
