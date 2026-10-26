/**
 * useFilterBuilder — open, apply, save and close the in-app filter builder.
 *
 * Apply writes the filter into `controls.workingFilter` and sends nothing to
 * Stash; Save writes it to the server *and* selects it; Cancel touches
 * neither. Focus is restored on every path because the control that opened
 * the builder unmounted under the focus, which drops it to <body> and leaves
 * the D-pad with no zone.
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
    // The Build control is remembered when the builder opens; the fallback
    // covers its having gone (the tab's controls changed while it was up),
    // which would leave the cursor on <body>.
    mainFocus.restore({ fallback: focusFirstControl });
  };

  const applyWorkingFilter = (objectFilter) => {
    setControls(prev => ({
      ...prev,
      workingFilter: objectFilter,
      // Stamped for the tab it applies to, so the next tab change does not
      // mistake it for a leftover.
      workingFilterFor: activeTab,
      // Null so the dropdown falls back to its own wording.
      workingFilterLabel: null,
      filterId: WORKING_FILTER_ID,
    }));
    closeBuilder();
  };

  const saveBuiltFilter = async ({ name, objectFilter }) => {
    // The sort on screen is the sort the filter should carry: a saved filter
    // is reopened elsewhere, and a bare criteria list comes back in Stash's
    // default order.
    const findFilter = { sort: controls.sort, direction: controls.order === 'asc' ? 'ASC' : 'DESC' };
    // Seeded from the active saved filter, so Save edits it in place rather
    // than forking a same-named copy.
    const id = controls.filterId && controls.filterId !== WORKING_FILTER_ID
      ? controls.filterId
      : undefined;
    const saved = await saveFilter({ id, mode: filterMode, name, objectFilter, findFilter });

    // `saveFilter` clears filterService's cache, but the hook is keyed on
    // mode + source; the epoch is what re-runs it so the entry appears.
    setFiltersEpoch(e => e + 1);

    // Built from what was sent rather than the mutation's echo: these are
    // already in the shape `fetchSavedFilters` yields, whereas `object_filter`
    // comes back in Stash's stored envelope. Without it the active-filter
    // resolution selects an id the list does not contain and fetches page 1
    // unfiltered before the epoch's answer arrives.
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
      // Selecting the saved filter rather than the working copy so the bar
      // shows the name the user gave it and later edits go via the server;
      // the label and tab marker go with the working copy.
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
