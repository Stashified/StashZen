/**
 * useFilteredNavigation: activating a tag, studio or gallery, and getting
 * back from what it opened.
 *
 * Activation routes through the filter machinery rather than new page types:
 * a tag or studio is a criterion on the scene filter and a gallery one on the
 * image filter, and those listings already page and draw cards. So "browse
 * the scenes behind this tag" is one tab change and one filter.
 *
 * The criterion is built in GraphQL shape, not Stash's stored shape: code
 * assembling a *request* should not write the saved-filter format.
 * `translateFilter` passes a criterion that declares `modifier`/`value`
 * straight through.
 */

import { useEffect, useState } from 'react';
import { WORKING_FILTER_ID } from './tabConfig.js';

export function useFilteredNavigation({ activeTab, dataKey, controls, changeTab, setControls }) {
  // Where an activated tag, studio or gallery sent the user *from*, so Back
  // can return: `{ tab, focusId, to, filter }`, the section, the card to focus
  // (returning to the top of a 533-row grid is not returning), the tab the
  // filter was applied for, and the filter state that tab had before.
  //
  // A stack, not one slot: a listing opened this way can open another one (a
  // studio card in a tag-filtered Studios listing, a gallery card on a
  // performer's galleries spoke), and Back must unwind one level at a time.
  // The displaced filter travels with its level, so the listing returns
  // filtered as the user left it.
  //
  // `to` duplicates `controls.workingFilterFor`, but the two are read by
  // separate guards (this tab effect and `onBack`); keeping the pair explicit
  // is cheaper than either guarding around the other's timing.
  const [filterOrigins, setFilterOrigins] = useState([]);

  // A source change ends every origin: the cards they name belong to the old
  // library, and the arrival rule below cannot clear them because the tab may
  // not change. Same render-phase reasoning as useListingControls.
  const [originForSource, setOriginForSource] = useState(null);
  if (originForSource !== dataKey) {
    setOriginForSource(dataKey);
    if (filterOrigins.length) setFilterOrigins([]);
  }

  // The stack ends with the tab change that meant to end it: the activation's
  // own change must not clear what it just set, or Back on a later tab jump
  // sends the user into a section they left several presses ago. Only the top
  // names the current level; the levels below it are the way back.
  //
  // An effect is fine here, this only affects Back, not a fetch, so the
  // child-before-parent ordering does not matter.
  useEffect(() => {
    setFilterOrigins(prev => {
      const top = prev[prev.length - 1];
      return top && top.to !== activeTab ? [] : prev;
    });
  }, [activeTab]);

  // Snapshot what the origin tab had applied, so Back returns to the listing
  // as it was left rather than bare. Taken at activation because that is the
  // last moment the fields still describe the origin.
  const filterAtOrigin = () => ({
    workingFilter: controls.workingFilter ?? null,
    workingFilterFor: controls.workingFilterFor ?? null,
    workingFilterLabel: controls.workingFilterLabel ?? null,
    filterId: controls.filterId ?? null,
  });

  // A gallery lands on Images and a tag or studio on Scenes, so the two
  // handlers differ in destination *and* in the tab Back returns to; the
  // origin is recorded per activation rather than assumed to be the previous
  // tab.
  //
  // `restorePerformer` marks a spoke opened from a performer page: the
  // performer record must survive the tab change so the page remounts under
  // it, and Back lands on the control that opened the spoke. See
  // useDetailSelection's clearing effect.
  const activateFiltered = (criterion, label, focusId, toTab, restorePerformer = null) => {
    const origin = { tab: activeTab, focusId, to: toTab, restorePerformer, filter: filterAtOrigin() };
    setFilterOrigins(prev => [...prev, origin]);
    setControls(prev => ({
      ...prev,
      workingFilter: criterion,
      workingFilterFor: toTab,
      workingFilterLabel: label,
      filterId: WORKING_FILTER_ID,
    }));
    changeTab(toTab);
  };

  // A fresh branch (Search's See-all, Home's shelf): start the stack over.
  // Nothing displaced needs to come back behind it, and keeping an older level
  // would let Back walk into a section the user left several presses ago.
  const replaceOrigin = (origin) => setFilterOrigins([{ ...origin, filter: filterAtOrigin() }]);

  // `originFocusId` is for an activation from a scene detail: the origin tab
  // has no tag or studio card, so Back focuses the scene the detail opened
  // from instead (see `handleGallerySelect`).
  // The labelled entry is the stored shape Stash uses; the request translator
  // unwraps it, and the filter builder can show the name when it reopens.
  const handleTagSelect = (tag, originFocusId = null) => activateFiltered(
    { tags: { modifier: 'INCLUDES', value: [{ id: tag.id, label: tag.name }] } },
    tag.name,
    originFocusId || `tag-${tag.id}`,
    'scenes',
  );

  const handleStudioSelect = (studio, originFocusId = null) => activateFiltered(
    { studios: { modifier: 'INCLUDES', value: [{ id: studio.id, label: studio.name }] } },
    studio.name,
    originFocusId || `studio-${studio.id}`,
    'scenes',
  );

  // A showroom shelf's See-all tile: set the request state and the origin,
  // then switch. Three differences from activateFiltered are the point:
  //
  //  - the target tab comes from the row (the Studios shelf opens the Studios
  //    listing, not a filtered scene listing),
  //  - the row's sort/order are staged for that arrival, and `sortForTab`
  //    tells the tab-change effect they were deliberate rather than a stray
  //    value to be replaced by the tab default,
  //  - `search` is cleared, since opening the full listing under a query left
  //    on the target tab would show something else than what was pressed.
  //
  // Continue Watching carries `resume_time > 0`, so Scenes opens under that
  // criterion; its label is the shelf heading, not "Custom filter".
  const openShowroomListing = (row) => {
    replaceOrigin({ tab: 'home', focusId: row.seeAllFocusId, to: row.toTab });
    setControls(prev => ({
      ...prev,
      sort: row.sort,
      order: row.order,
      // Same batch as the tab switch, so the listing's first fetch already
      // uses the shelf's sort rather than fetching the default and refetching.
      sortForTab: row.toTab,
      search: '',
      workingFilter: row.filter,
      workingFilterFor: row.filter ? row.toTab : null,
      workingFilterLabel: row.filter ? row.heading : null,
      filterId: row.filter ? WORKING_FILTER_ID : null,
    }));
    changeTab(row.toTab);
  };

  // The recorded focus id must name something that exists in the origin tab.
  // A gallery opened from Galleries has `gallery-<id>`, but the scene-detail
  // hand-off leaves that tab: on Back there is no `gallery-` card, so a scene
  // names its own card (`video-<id>`, the prefix both listings use). The
  // caller can pass the origin's own id instead, for a tab with no video card.
  const handleGallerySelect = (gallery, sceneId = null, originFocusId = null) => activateFiltered(
    { galleries: { modifier: 'INCLUDES', value: [{ id: gallery.id, label: gallery.title }] } },
    gallery.title,
    originFocusId || (sceneId ? `video-${sceneId}` : `gallery-${gallery.id}`),
    'images',
  );

  return {
    filterOrigins,
    setFilterOrigins,
    activateFiltered,
    replaceOrigin,
    openShowroomListing,
    handleTagSelect,
    handleStudioSelect,
    handleGallerySelect,
  };
}
