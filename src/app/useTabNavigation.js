/**
 * useTabNavigation: which section is showing, and the two ways it moves.
 *
 * `activeTab` and `tabEpoch` are both part of the page's remount key;
 * `changeTab` is the only writer of either.
 */

import { useState } from 'react';
import { clearAllListCaches } from '../utils/listCache.js';

export function useTabNavigation(initial = 'home') {
  const [activeTab, setActiveTab] = useState(initial);
  // Bumped only when the rail's *current* row is pressed, an explicit
  // reload of the tab already on screen. It is part of `<main>`'s key, so the
  // bump remounts the page the same way a tab change does.
  const [tabEpoch, setTabEpoch] = useState(0);

  // Every tab switch drops the tab's module-scoped page caches (listCache.js)
  // so the remount actually re-reads instead of being served the old rows.
  // Switching tab is a TV's pull-to-refresh; pressing the current row does it
  // in place.
  //
  // Cleared before the state moves: effects run child-first after the commit,
  // so the arriving page would already have been served the old page.
  const changeTab = (tab) => {
    clearAllListCaches();
    if (tab === activeTab) setTabEpoch(n => n + 1);
    else setActiveTab(tab);
  };

  return { activeTab, tabEpoch, changeTab };
}
