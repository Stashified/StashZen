/**
 * controlRestore: the listing controls Back has to put back.
 *
 * Search, the quick chips, sort and order are per section in practice: the
 * arrival rule resets them on every tab change. A cross-tab Back is not a fresh
 * visit, so it snapshots them with the filter and stages the snapshot under
 * `restoreForTab`, which tells the rule to keep it (see useListingControls).
 */

export function snapshotControls(controls) {
  return {
    workingFilter: controls.workingFilter ?? null,
    workingFilterFor: controls.workingFilterFor ?? null,
    workingFilterLabel: controls.workingFilterLabel ?? null,
    filterId: controls.filterId ?? null,
    search: controls.search ?? '',
    quickFilters: [...(controls.quickFilters || [])],
    sort: controls.sort,
    order: controls.order,
  };
}

// One marker for the whole snapshot: a per-field hand-off would let the
// arrival defaults overwrite the fields it forgot.
export function restoreControls(setControls, snapshot, tab) {
  setControls(prev => ({ ...prev, ...snapshot, restoreForTab: tab }));
}
