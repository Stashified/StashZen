/**
 * useFilterBuilder — open, apply, save and close the in-app filter builder.
 *
 * Three ways out of the builder, and they differ in what they leave behind:
 * Apply writes the filter into `controls.workingFilter` and nothing is sent
 * to Stash; Save writes it to the server *and* selects it; Cancel touches
 * neither. Focus is restored on every path for the same reason the settings
 * panel restores it — the control that opened the builder unmounted under
 * the focus, which drops it to <body> and leaves the D-pad with no zone.
 */

import { useState } from 'react';
import { saveFilter } from '../utils/filterService.js';
import { focusFirstControl } from '../utils/focus.js';
import { WORKING_FILTER_ID } from './tabConfig.js';

export function useFilterBuilder({
  activeTab,
  filterMode,
  dataKey,
  controls,
  setControls,
  setFiltersEpoch,
  setSavedFilterEcho,
  mainFocus,
}) {
  const [builderOpen, setBuilderOpen] = useState(false);

  const closeBuilder = () => {
    setBuilderOpen(false);
    // The Build control is remembered when the builder opens. The fallback
    // covers the case where it has gone (the tab's controls changed while the
    // builder was up): without it the cursor stays on <body> and horizontal
    // navigation has no zone to move from.
    mainFocus.restore({ fallback: focusFirstControl });
  };

  const applyWorkingFilter = (objectFilter) => {
    setControls(prev => ({
      ...prev,
      workingFilter: objectFilter,
      // Stamped for the tab it is being applied to — the builder is only ever
      // opened from, and applies to, the tab you are on. This is what stops the
      // next tab change from mistaking it for a leftover.
      workingFilterFor: activeTab,
      // Explicitly the builder's case, so the dropdown falls back to its own
      // wording. A tag or studio activation sets a name here instead.
      workingFilterLabel: null,
      filterId: WORKING_FILTER_ID,
    }));
    closeBuilder();
  };

  const saveBuiltFilter = async ({ name, objectFilter }) => {
    // The sort the user is looking at is the sort the filter should carry,
    // since a saved filter is reopened elsewhere and a bare criteria list
    // with no sort would come back in Stash's default order.
    const findFilter = { sort: controls.sort, direction: controls.order === 'asc' ? 'ASC' : 'DESC' };
    const saved = await saveFilter({ mode: filterMode, name, objectFilter, findFilter });

    // Re-fetch: `saveFilter` clears filterService's module cache, but the
    // hook is keyed on mode + source, so it has no reason to re-run on its
    // own. The epoch is what makes the new entry appear in the dropdown.
    setFiltersEpoch(e => e + 1);

    // The entry the refetch is about to deliver, built from what was sent
    // rather than from the mutation's echo: these are already in the shape
    // `fetchSavedFilters` yields, whereas `object_filter` comes back in
    // Stash's stored envelope. Without it the active-filter resolution selects
    // an id the list does not contain yet — it comes back null, and the
    // listing fetches page 1 unfiltered before the epoch's answer arrives.
    if (saved?.id != null) {
      setSavedFilterEcho({
        id: String(saved.id),
        name: saved.name || name,
        mode: filterMode,
        source: dataKey,
        objectFilter,
        findFilter,
      });
    }

    setControls(prev => ({
      ...prev,
      // Selecting the saved filter rather than keeping the working copy: they
      // are the same filter, and this way the bar shows the name the user
      // just gave it, and editing it later goes back through the server. The
      // label and the tab marker go with the working copy they described.
      workingFilter: null,
      workingFilterFor: null,
      workingFilterLabel: null,
      filterId: saved?.id != null ? String(saved.id) : prev.filterId,
    }));
    closeBuilder();
  };

  return {
    builderOpen,
    setBuilderOpen,
    closeBuilder,
    applyWorkingFilter,
    saveBuiltFilter,
  };
}
