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

export function useFilteredNavigation({ activeTab, dataKey, changeTab, setControls }) {
  // Where an activated tag, studio or gallery sent the user *from*, so Back
  // can return: `{ tab, focusId, to }`, the section, the card to focus
  // (returning to the top of a 533-row grid is not returning), and the tab
  // the filter was applied for.
  //
  // `to` duplicates `controls.workingFilterFor`, but the two are read by
  // separate guards (this tab effect and `onBack`); keeping the pair explicit
  // is cheaper than either guarding around the other's timing.
  const [filterOrigin, setFilterOrigin] = useState(null);

  // A source change ends any origin: the card it names belongs to the old
  // library, and the arrival rule below cannot clear it because the tab may
  // not change. Same render-phase reasoning as useListingControls.
  const [originForSource, setOriginForSource] = useState(null);
  if (originForSource !== dataKey) {
    setOriginForSource(dataKey);
    if (filterOrigin) setFilterOrigin(null);
  }

  // The origin ends with the tab change that meant to end it: the activation's
  // own change must not clear what it just set, or Back on a later tab jump
  // sends the user into a section they left several presses ago.
  //
  // An effect is fine here, this only affects Back, not a fetch, so the
  // child-before-parent ordering does not matter.
  useEffect(() => {
    setFilterOrigin(prev => (prev && prev.to !== activeTab ? null : prev));
  }, [activeTab]);

  // A gallery lands on Images and a tag or studio on Scenes, so the two
  // handlers differ in destination *and* in the tab Back returns to; the
  // origin is recorded per activation rather than assumed to be the previous
  // tab.
  const activateFiltered = (criterion, label, focusId, toTab) => {
    setFilterOrigin({ tab: activeTab, focusId, to: toTab });
    setControls(prev => ({
      ...prev,
      workingFilter: criterion,
      workingFilterFor: toTab,
      workingFilterLabel: label,
      filterId: WORKING_FILTER_ID,
    }));
    changeTab(toTab);
  };

  const handleTagSelect = (tag) => activateFiltered(
    { tags: { modifier: 'INCLUDES', value: [tag.id] } },
    tag.name,
    `tag-${tag.id}`,
    'scenes',
  );

  const handleStudioSelect = (studio) => activateFiltered(
    { studios: { modifier: 'INCLUDES', value: [studio.id] } },
    studio.name,
    `studio-${studio.id}`,
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
    setFilterOrigin({ tab: 'home', focusId: row.seeAllFocusId, to: row.toTab });
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
  // names its own card (`video-<id>`, the prefix both listings use).
  const handleGallerySelect = (gallery, sceneId = null) => activateFiltered(
    { galleries: { modifier: 'INCLUDES', value: [gallery.id] } },
    gallery.title,
    sceneId ? `video-${sceneId}` : `gallery-${gallery.id}`,
    'images',
  );

  return {
    filterOrigin,
    setFilterOrigin,
    activateFiltered,
    openShowroomListing,
    handleTagSelect,
    handleStudioSelect,
    handleGallerySelect,
  };
}
