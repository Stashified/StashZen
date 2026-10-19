/**
 * useListingControls — the controls bar's state, and the rules that arrive
 * with it.
 *
 * `controls` is one shared object for every section, so most of what this
 * hook does is deciding what survives a tab change or a data-source change.
 * Both rules are render-phase updates, not effects: the arriving page mounts
 * its grid in the same commit, and its first fetch must already carry the
 * new tab's sort, order and filter.
 *
 * The view mode and grid column count are per-tab but live in the settings
 * store rather than in `controls`, so they survive a launch; the accessors
 * here are the per-tab views of those maps.
 */

import { useState } from 'react';
import { setSettings } from '../utils/settings.js';
import { flattenSortGroups } from '../utils/sortGroups.js';
import { DEFAULT_CONTROLS, TAB_CONTROL_CONFIG, WORKING_FILTER_ID } from './tabConfig.js';

export function useListingControls({ activeTab, dataKey, settings }) {
  const [controls, setControls] = useState(DEFAULT_CONTROLS);

  // ── View mode, per section ───────────────────────────────
  // Absent means 'classic' — see readViewModes in settings.js. Stored rather
  // than held in `controls` so it survives a launch, and keyed by tab so
  // setting Performers to Carousel leaves Scenes alone.
  //
  // The whole map is written on every change rather than merged into the
  // stored copy here: `setSettings` spreads a patch over the current state, so
  // the spread below is what keeps the *other* tabs' modes. Writing only
  // `{ [activeTab]: v }` would silently reset every other section to classic.
  const viewModes = settings.viewModes;
  const activeMode = viewModes[activeTab] ?? 'classic';
  const setActiveMode = (mode) => {
    setSettings({ viewModes: { ...viewModes, [activeTab]: mode } });
  };

  // ── Grid columns, per section ────────────────────────────
  // Same shape and same reasoning as viewModes above: stored in the settings
  // store rather than in `controls` so the choice survives a launch, keyed by
  // tab so changing one section leaves the others alone, and the whole map is
  // written on every change because `setSettings` replaces the field wholesale.
  //
  // The defaults differ because the art does: scenes, markers and the entity
  // grids are landscape at 4, while performer cards are 3:4 portrait — at 4
  // they fill the same cell with nearly 2.4× the height and read as oversized
  // on a TV. 6 is the measured choice, not arithmetic. Reported from the TV,
  // 2026-10-17: "around 6 looked alright".
  const gridCols = settings.gridCols;
  const gridColsFor = (tab) => gridCols[tab] ?? (tab === 'performers' ? 6 : 4);

  // ── A data-source change is an arrival too ───────────────
  //
  // Switching between Live and Test, or pointing the app at another server,
  // remounts `<main>` through its key — the pages, their fetches and their
  // rows are discarded. App's own state is not: the selected filter id, an
  // open performer or scene detail, the origin a filtered listing came from.
  // A saved-filter id names a row on the *old* server. Kept across the
  // switch it either names nothing — so the listing silently runs unfiltered
  // while the bar shows a filter — or names a different filter entirely. The
  // detail pages hold an id and a record from the old library. Cleared in
  // render, not in an effect, for the same reason the tab rule below is: the
  // new source's first fetch must not go out under the old source's filter
  // or hold a detail the new listing cannot back up.
  //
  // The ticker is the source, so this runs once per source; the tab rule
  // below runs once per tab. They are independent because a source change
  // keeps the tab and a tab change keeps the source.
  //
  // The detail and origin state this used to clear in the same pass belongs
  // to useDetailSelection and useFilteredNavigation now; each resets its own
  // with its own source ticker. All of those updates happen in the same
  // render and batch into one re-render, which is why the rules can live
  // apart without changing what the user sees.
  const [controlsForSource, setControlsForSource] = useState(null);
  if (controlsForSource !== dataKey) {
    setControlsForSource(dataKey);
    setControls(prev => (
      prev.filterId || prev.workingFilter
        ? {
            ...prev,
            filterId: null,
            workingFilter: null,
            workingFilterFor: null,
            workingFilterLabel: null,
          }
        : prev
    ));
  }

  // ── Arriving at a tab adopts its defaults ────────────────
  //
  // When switching tabs, adopt the tab's default sort — with one exception.
  //
  // Arriving at a section means arriving at its declared `defaultSort` (Tags
  // and Studios by Name, Galleries and Images newest first) and at its
  // `defaultOrder` — Tags ascending, everything without a declaration
  // descending. The old rule only
  // coerced the sort when the carried value was *invalid* for the new tab,
  // which left `created_at` — valid everywhere — leaking onto Tags. A default
  // that only applies sometimes is not a default.
  //
  // The exception is a See-all hand-off. The showroom tile knows which sort
  // its shelf was drawn with (`date` for released scenes and galleries,
  // `last_played_at` for Continue Watching), and `openShowroomListing` stages
  // that sort and names the destination tab in the same batch as the tab
  // switch. `sortForTab` is what tells this arrival rule
  // "this arrival was deliberate, keep the staged sort". It is validated
  // against the target's vocabulary all the same, so a row whose sort is not
  // offered in its destination falls back to the default instead of landing
  // on a control that renders a raw value.
  //
  // The marker is cleared on every run, in the same updater that reads it: a
  // leftover would let the *next* arrival at that tab keep whatever sort was
  // current then, silently disabling the default rule. Cleared even for a tab
  // with no sort groups, so it can never survive an unexpected destination.
  //
  // This runs *during render*, not in an effect, and that is the point.
  // Effects fire child-first: on arrival at Markers its grid was already
  // mounted and its `usePagedList` reset effect had fired, so it fetched page
  // 1 with the sort carried over from Scenes (`created_at`), and only then did
  // this component's effect adopt the tab default (`title`) and make the grid
  // fetch page 1 again. Measured on the harness fake: two `FindSceneMarkers`
  // page-1 requests per arrival, the first answer thrown away — the "small
  // delay switching to Markers" reported from the TV. A render-phase update
  // re-renders this component before anything commits, so the grid mounts
  // already carrying its tab's controls and fetches once.
  //
  // `controlsForTab` is the ticker that keeps that update from running on
  // every render. It is separate from `controls` so `updateControls` does not
  // have to know to leave it alone.
  const [controlsForTab, setControlsForTab] = useState(null);
  if (controlsForTab !== activeTab) {
    setControlsForTab(activeTab);
    const config = TAB_CONTROL_CONFIG[activeTab];
    const flat = flattenSortGroups(config?.sortGroups);

    setControls(prev => {
      // Columns follow the section, not the session. `controls` is one shared
      // object, so without this the number of columns chosen on Performers
      // would be carried onto Scenes — exactly the bug the per-section store
      // exists to prevent. Written unconditionally: arriving at a tab always
      // adopts that tab's count, stored or default.
      const patch = { cols: gridColsFor(activeTab), sortForTab: null };
      if (flat.length) {
        const validValues = flat.map(o => o.value);
        const handoff = prev.sortForTab === activeTab && validValues.includes(prev.sort);
        if (!handoff && config.defaultSort) {
          // Sort and order travel together: a declaration that names a sort
          // but inherits the previous tab's direction can open Tags on
          // "Name, Descending". Adopt both, and reset the ones with no
          // declaration to the global default so Tags' asc cannot leak into
          // a date-sorted tab. A hand-off keeps the shelf's staged pair.
          patch.sort = config.defaultSort;
          patch.order = config.defaultOrder || 'desc';
        }
      }
      // ── The filter, and why this rule is not the problem it looks like ──
      //
      // Activating a tag sets `workingFilter` and switches to Scenes in the same
      // batch, so this run sees a filter that was applied *by* the tab
      // change it is reacting to. Clearing unconditionally — which is what it
      // used to do — would wipe the filter in the act of applying it.
      //
      // `workingFilterFor` is what separates arrival from departure: the filter
      // names the tab it was applied for, so this run can tell "the user just
      // arrived here under a filter" (equal, leave it) from "the user left the
      // tab that filter belonged to" (not equal, drop it). It is a field rather
      // than a consume-once ref because it has to survive re-running — a ref
      // would be spent by the first run and a second run (StrictMode, a
      // remount) would then clear the filter it was guarding.
      const filterIsForThisTab = prev.workingFilter && prev.workingFilterFor === activeTab;

      if (prev.workingFilter && !filterIsForThisTab) {
        patch.workingFilter = null;
        patch.workingFilterFor = null;
        patch.workingFilterLabel = null;
      }

      // Saved-filter ids belong to a specific saved-filter mode, so switching
      // tabs (and thus mode) invalidates whatever was selected. The working
      // marker is the exception while the filter it stands for is staying: it
      // is not a server id at all, and clearing it would deselect the dropdown
      // entry for the filter that caused this tab change. Every other case —
      // including the marker on a filter that has just been dropped — clears.
      if (prev.filterId && !(prev.filterId === WORKING_FILTER_ID && filterIsForThisTab)) {
        patch.filterId = null;
      }

      return { ...prev, ...patch };
    });
  }

  const updateControls = (patch, savedFilters) => {
    // A column change is a preference, not just view state: it goes to the
    // settings store so this section reopens at the same count next launch,
    // and so the tab-change effect above can hand it back. Done here and not
    // inside the updater below — an updater can run twice under StrictMode,
    // and writing storage from one would double-persist.
    if (patch.cols !== undefined) {
      setSettings({ gridCols: { ...gridCols, [activeTab]: patch.cols } });
    }
    setControls(prev => {
      // Moving the dropdown off the in-memory filter discards it. Checked
      // against the *raw* patch value, not the truthiness the branch below
      // uses: "All" is `''`, and that is a move away just as much as picking a
      // saved filter is. Without this, choosing All would leave the built
      // filter silently applied.
      if (patch.filterId !== undefined && patch.filterId !== prev.filterId
          && patch.filterId !== WORKING_FILTER_ID && prev.workingFilter) {
        patch.workingFilter = null;
        // The label and the tab marker go with it. Leaving the label would
        // have the dropdown name a filter that is no longer applied the next
        // time one is; leaving the marker would tell the tab-change effect that
        // a filter it no longer has belongs to this tab.
        patch.workingFilterLabel = null;
        patch.workingFilterFor = null;
      }

      // Picking a saved filter: also adopt its sort/direction so the
      // visible Sort/Order controls reflect what's actually applied.
      // The user can still override afterwards.
      if (patch.filterId && patch.filterId !== prev.filterId) {
        const f = savedFilters.find(x => String(x.id) === String(patch.filterId));
        if (f?.findFilter?.sort) patch.sort = f.findFilter.sort;
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
