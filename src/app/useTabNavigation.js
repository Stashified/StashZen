/**
 * useTabNavigation — which section is showing, and the two ways it moves.
 *
 * Extracted from App unchanged. Both `activeTab` and `tabEpoch` are part of
 * the page's remount key, and `changeTab` is the only writer of either.
 */

import { useState } from 'react';
import { clearAllListCaches } from '../utils/listCache.js';

export function useTabNavigation(initial = 'home') {
  const [activeTab, setActiveTab] = useState(initial);
  // Bumped only when the rail's *current* row is pressed — an explicit
  // reload of the tab already on screen. It is part of `<main>`'s key, so the
  // bump remounts the page the same way a tab change does.
  const [tabEpoch, setTabEpoch] = useState(0);

  // Every tab switch goes through here, so leaving a tab is also when its
  // module-scoped page caches are dropped (see listCache.js).
  //
  // A tab change remounts the tab's page, and before this the remount's
  // "fetch" was a cache hit: the page looked like it reloaded and showed
  // exactly the rows it had before. A scene added or removed on the Stash
  // server therefore stayed invisible for as long as the app ran — the
  // reported workaround was closing and relaunching it. Switching tab is
  // what a TV has instead of pull-to-refresh; it has to mean "read again".
  // Pressing the current row does exactly that in place; it is the one
  // gesture that refreshes without leaving the tab.
  //
  // Clears before the state moves, not in an effect: effects run child-first
  // after the commit, so the arriving page would already have asked (and been
  // served the old page) by the time a parent effect cleared anything.
  const changeTab = (tab) => {
    clearAllListCaches();
    if (tab === activeTab) setTabEpoch(n => n + 1);
    else setActiveTab(tab);
  };

  return { activeTab, tabEpoch, changeTab };
}
