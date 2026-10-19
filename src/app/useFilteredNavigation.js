/**
 * useFilteredNavigation — activating a tag, studio or gallery, and getting
 * back from what it opened.
 *
 * Activation routes through the filter machinery rather than through new page
 * types. A tag or a studio *is* a criterion on the scene filter and a gallery
 * is a criterion on the image filter, and both of those listings already
 * exist, page themselves and know how to draw a card — so the whole of "browse
 * the scenes behind this tag" is one tab change and one filter.
 *
 * The criterion is built in GraphQL shape rather than in Stash's stored
 * shape. `translateFilter` passes a criterion that already declares
 * `modifier`/`value` straight through (its header documents that idempotence),
 * and code assembling a *request* has no business writing the saved-filter
 * format — that would make the app depend on a format it only reads by
 * accident. The two shapes are one `translateFilter` apart and this is the
 * side of the line the app is on.
 */

import { useEffect, useState } from 'react';
import { WORKING_FILTER_ID } from './tabConfig.js';

export function useFilteredNavigation({ activeTab, dataKey, changeTab, setControls }) {
  // Where an activated tag, studio or gallery sent the user *from*, so Back can
  // put them back: `{ tab, focusId, to }` — the section to return to, the card
  // to return to inside it (returning to a 533-row tag grid at the top is not
  // returning), and the tab the filter was applied for.
  //
  // `to` looks redundant against `controls.workingFilterFor`, which holds the
  // same value, and it is: the two are written together in `activateFiltered`
  // and read separately, because the guard that ends one of them lives in the
  // tab effect and the guard that uses the other lives in `onBack`. Keeping the
  // pair explicit is cheaper than having either guard reason about the other's
  // timing.
  const [filterOrigin, setFilterOrigin] = useState(null);

  // A source change ends any origin: the card it names belongs to the old
  // library, and the arrival rule below cannot clear it because the tab may
  // not change. See useListingControls for the same render-phase reasoning.
  const [originForSource, setOriginForSource] = useState(null);
  if (originForSource !== dataKey) {
    setOriginForSource(dataKey);
    if (filterOrigin) setFilterOrigin(null);
  }

  // The origin ends with the tab change that meant to end it. Same arrival-vs-
  // departure distinction as the controls rule, and the same reason for `to`
  // being a stored field: the activation's own tab change must not clear the
  // origin it just set. Left behind, it would have Back on some later tab jump
  // the user into a section they left several presses ago.
  //
  // This half stays in an effect — it only affects Back, not a fetch, so the
  // child-before-parent ordering that forced the controls into render does not
  // matter here.
  useEffect(() => {
    setFilterOrigin(prev => (prev && prev.to !== activeTab ? null : prev));
  }, [activeTab]);

  // `focusByIdWhenReady` gets back to the card that was pressed; `filterOrigin`
  // is what remembers it. Note that a gallery lands on Images and a tag or
  // studio lands on Scenes, so the two handlers differ in their destination
  // *and* in which tab Back returns to — which is why the origin is recorded
  // per activation rather than assumed to be "the tab before this one".
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

  // A showroom shelf's See-all tile. Same shape as activateFiltered — set the
  // request state and the origin, then switch — with three differences that
  // are the whole point of the tile:
  //
  //  - the target tab comes from the row (the Studios shelf opens the Studios
  //    listing, not a filtered scene listing),
  //  - the row's sort and order are staged for that arrival, and
  //    `sortForTab` tells the tab-change effect they were deliberate rather
  //    than a stray value to be replaced by the tab default, and
  //  - `search` is cleared. The shelf was never searched, so opening its full
  //    listing under a query left on the target tab would show something
  //    other than what the user just pressed "See all" on.
  //
  // Four of the five shelves are unfiltered; Continue Watching carries
  // `resume_time > 0`, and this branch is what makes its See all open Scenes
  // under that same criterion rather than the whole library. The label is the
  // shelf's own heading, so the dropdown says "Continue Watching" instead of
  // falling back to "Custom filter" for a filter the app itself created.
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

  const handleGallerySelect = (gallery) => activateFiltered(
    { galleries: { modifier: 'INCLUDES', value: [gallery.id] } },
    gallery.title,
    `gallery-${gallery.id}`,
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
