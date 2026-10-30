/**
 * useListingControls: the controls bar's state, and the rules that arrive
 * with it.
 *
 * `controls` is one shared object for every section, so most of this hook is
 * deciding what survives a tab change or a data-source change. Both rules are
 * render-phase updates, not effects: the arriving page mounts its grid in the
 * same commit, and its first fetch must already carry the new tab's controls.
 *
 * View mode and grid columns are per-tab but live in the settings store, so
 * they survive a launch.
 */

import { useState } from 'react';
import { setSettings } from '../utils/settings.js';
import { flattenSortGroups } from '../utils/sortGroups.js';
import { DEFAULT_CONTROLS, TAB_CONTROL_CONFIG, WORKING_FILTER_ID } from './tabConfig.js';

export function useListingControls({ activeTab, dataKey, settings }) {
  const [controls, setControls] = useState(DEFAULT_CONTROLS);

  // ── View mode, per section ───────────────────────────────
  // Absent means the section's `defaultMode`, else 'classic', see readViewModes
  // in settings.js. Keyed by tab so setting Performers to Carousel leaves
  // Scenes alone.
  //
  // The whole map is written on every change because `setSettings` spreads a
  // patch over the current state; writing only `{ [activeTab]: v }` would
  // silently reset every other section to classic.
  const viewModes = settings.viewModes;
  const activeMode = viewModes[activeTab] ?? TAB_CONTROL_CONFIG[activeTab]?.defaultMode ?? 'classic';
  const setActiveMode = (mode) => {
    setSettings({ viewModes: { ...viewModes, [activeTab]: mode } });
  };

  // ── Grid columns, per section ────────────────────────────
  // Same shape and reasoning as viewModes: stored, per-tab, and the whole map
  // written every change because `setSettings` replaces the field wholesale.
  //
  // The defaults differ because the art does: scenes, markers and entity grids
  // are landscape at 4, while performer cards are 3:4 portrait, at 4 they read
  // as oversized on a TV. 6 is the measured choice.
  const gridCols = settings.gridCols;
  const gridColsFor = (tab) => gridCols[tab] ?? (tab === 'performers' ? 6 : 4);

  // ── A data-source change is an arrival too ───────────────
  //
  // Switching between Live and Test, or pointing at another server, remounts
  // `<main>` through its key, but App's state is not: a saved-filter id names a
  // row on the *old* server, and kept across the switch it either names nothing
  //, so the listing runs unfiltered while the bar shows a filter, or a
  // different filter. The detail pages hold ids from the old library too.
  //
  // Cleared in render, not an effect: the new source's first fetch must not go
  // out under the old filter. The ticker is the source, so this runs once per
  // source; the tab rule below is independent of it.
  //
  // The detail and origin state each reset their own with their own ticker;
  // all these updates batch into one re-render.
  const [controlsForSource, setControlsForSource] = useState(null);
  if (controlsForSource !== dataKey) {
    setControlsForSource(dataKey);
    setControls(prev => (
      prev.filterId || prev.workingFilter || prev.quickFilters?.length
        ? {
            ...prev,
            filterId: null,
            workingFilter: null,
            workingFilterFor: null,
            workingFilterLabel: null,
            // Chip ids are per-type, and a gallery chip's remains meaningless
            // on Images' schema: start the new source with none.
            quickFilters: [],
          }
        : prev
    ));
  }

  // ── Arriving at a tab adopts its defaults ────────────────
  //
  // Arriving at a section adopts its declared `defaultSort`/`defaultOrder`
  // (Tags and Studios by name ascending, the rest newest first), replacing the
  // carried value even when it is valid for the new tab, a default that only
  // applies sometimes is not a default.
  //
  // The exception is a See-all hand-off: `openShowroomListing` stages the
  // shelf's sort and names the destination tab in the same batch, and
  // `sortForTab` tells this rule the arrival was deliberate. It is still
  // validated against the target's vocabulary, so an unsupported sort falls
  // back rather than landing on a control that renders a raw value. The marker
  // is cleared on every run in the same updater, or a leftover would silently
  // disable the default rule on the next arrival.
  //
  // Render-phase, not an effect: effects fire child-first, so the arriving
  // grid would already have fetched page 1 with the previous tab's sort and
  // then refetch, the "small delay switching to Markers" seen on the TV. A
  // render-phase update re-renders before anything commits, so the grid mounts
  // already carrying its tab's controls and fetches once. `controlsForTab` is
  // the ticker that keeps this from running every render.
  const [controlsForTab, setControlsForTab] = useState(null);
  if (controlsForTab !== activeTab) {
    setControlsForTab(activeTab);
    const config = TAB_CONTROL_CONFIG[activeTab];
    const flat = flattenSortGroups(config?.sortGroups);

    setControls(prev => {
      // Columns follow the section, not the session: `controls` is shared, so
      // without this the Performers count would carry onto Scenes. Written
      // unconditionally, arrival always adopts the tab's count, stored or
      // default.
      //
      // Search goes too for the same reason: a term narrows the listing it was
      // typed against, and carried onto another section it silently narrows a
      // listing the user never searched. The one exception is the global search
      // page's See-all hand-off, which stages its query for this arrival;
      // pressing the current rail row reloads in place (`tabEpoch`) and keeps
      // the query.
      const searchHandoff = prev.searchForTab === activeTab;
      const patch = {
        cols: gridColsFor(activeTab),
        sortForTab: null,
        searchForTab: null,
        search: searchHandoff ? prev.search : '',
        // Chips are quick narrowings of the listing they were pressed on, and
        // the ids differ per section. A See-all hand-off stages its own filter
        // and arrives clear like everything else.
        quickFilters: [],
      };
      if (flat.length) {
        const validValues = flat.map(o => o.value);
        const handoff = prev.sortForTab === activeTab && validValues.includes(prev.sort);
        if (!handoff && config.defaultSort) {
          // Sort and order travel together: a declaration naming a sort but
          // inheriting the previous direction opens Tags on "Name,
          // Descending". A hand-off keeps the shelf's staged pair.
          patch.sort = config.defaultSort;
          patch.order = config.defaultOrder || 'desc';
        }
      }
      // ── The filter, and why this rule is not the problem it looks like ──
      //
      // Activating a tag sets `workingFilter` and switches to Scenes in the
      // same batch, so this run sees a filter applied *by* the change it is
      // reacting to; clearing unconditionally would wipe it in the act.
      //
      // `workingFilterFor` separates arrival from departure: "arrived here
      // under this filter" (equal, leave it) vs "left the tab that filter
      // belonged to" (drop it). A field rather than a consume-once ref, which
      // a second run (StrictMode, a remount) would find already spent.
      const filterIsForThisTab = prev.workingFilter && prev.workingFilterFor === activeTab;

      if (prev.workingFilter && !filterIsForThisTab) {
        patch.workingFilter = null;
        patch.workingFilterFor = null;
        patch.workingFilterLabel = null;
      }

      // Saved-filter ids belong to a mode, so a tab change (and thus mode
      // change) invalidates the selection. The working marker is the exception
      // while its filter is staying: it is not a server id, and clearing it
      // would deselect the dropdown entry for the filter that caused this
      // change. Every other case, including a dropped filter's marker, clears.
      if (prev.filterId && !(prev.filterId === WORKING_FILTER_ID && filterIsForThisTab)) {
        patch.filterId = null;
      }

      return { ...prev, ...patch };
    });
  }

  const updateControls = (patch, savedFilters) => {
    // A column change is a preference: persist it so the section reopens at the
    // same count. Done outside the updater below, which StrictMode can run
    // twice, writing storage from one would double-persist.
    if (patch.cols !== undefined) {
      setSettings({ gridCols: { ...gridCols, [activeTab]: patch.cols } });
    }
    setControls(prev => {
      // Moving the dropdown off the in-memory filter discards it. Checked
      // against the raw patch value: "All" is `''`, a move away just like
      // picking a saved filter. Without this, choosing All would silently leave
      // the built filter applied.
      if (patch.filterId !== undefined && patch.filterId !== prev.filterId
          && patch.filterId !== WORKING_FILTER_ID && prev.workingFilter) {
        patch.workingFilter = null;
        // The label and tab marker go with it: leaving the label names a
        // filter no longer applied, and the marker would tell the tab-change
        // effect a filter it no longer has belongs to this tab.
        patch.workingFilterLabel = null;
        patch.workingFilterFor = null;
      }

      // Picking a saved filter: also adopt its sort/direction so the
      // visible Sort/Order controls reflect what's actually applied.
      // The user can still override afterwards.
      if (patch.filterId && patch.filterId !== prev.filterId) {
        const f = savedFilters.find(x => String(x.id) === String(patch.filterId));
        // A filter made in Stash's web UI can carry a sort this tab does not
        // offer. Adopting it would leave the Sort control showing a value it
        // cannot select. Same check the See-all hand-off gets.
        const validSorts = flattenSortGroups(
          TAB_CONTROL_CONFIG[activeTab]?.sortGroups,
        ).map(o => o.value);
        if (f?.findFilter?.sort
            && (!validSorts.length || validSorts.includes(f.findFilter.sort))) {
          patch.sort = f.findFilter.sort;
        }
        if (f?.findFilter?.direction) {
          patch.order = f.findFilter.direction.toLowerCase() === 'asc' ? 'asc' : 'desc';
        }
      }
      return { ...prev, ...patch };
    });
  };

  return {
    controls, setControls, updateControls, activeMode, setActiveMode,
  };
}
