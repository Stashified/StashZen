/**
 * filterSelection.js — pure rules for turning the controls bar into the
 * listing that gets fetched.
 *
 * None of this touches React: every function here is a function of `controls`,
 * the saved-filter list, and the echo App holds for a filter it has just
 * saved. The rules are documented where they were written, because each one
 * is a distinction that looks like a cleanup and is not.
 */

import { WORKING_FILTER_ID } from '../app/tabConfig.js';

/** The saved filter the controls bar's id names, or null. */
export function findActiveFilter(filterChoices, filterId) {
  return filterId
    ? filterChoices.find(f => String(f.id) === String(filterId))
    : null;
}

/**
 * Three states, and the ordering is the whole rule: a hand-built filter
 * beats a saved one, because the builder is only ever opened *onto* the
 * current selection and Apply is an explicit act. `??` rather than `||`
 * because `{}` is a legitimate working filter — "no criteria" — and `||`
 * would fall through to the saved filter underneath and apply it instead.
 *
 * No cache invalidation is needed when this changes: `listCacheKey` folds
 * JSON.stringify(filter) in, so a different filter is a different key. The
 * `dataKey` remount stays reserved for a source change.
 */
export function resolveObjectFilter(controls, activeFilter) {
  return controls.workingFilter ?? activeFilter?.objectFilter ?? null;
}

/**
 * `savedFilters` is the list the hook has *currently delivered*, and a save
 * leaves it one epoch behind: `saveBuiltFilter` selects the new id in the
 * same batch that bumps the epoch, so for at least one render the selected
 * id names nothing, `activeFilter` is null, and the listing fetches page 1
 * unfiltered — the visible flash of the whole library — and then refetches
 * once the list catches up. The echo closes that window: it stands in for
 * the entry the server is about to return. It is used only while the real
 * list lacks the id, and only for the mode and source that saved it; saved
 * ids are namespaced per mode and name rows on one server.
 */
export function mergeFilterEcho(savedFilters, echo, filterMode, dataKey) {
  return echo
      && echo.mode === filterMode
      && echo.source === dataKey
      && !savedFilters.some(f => String(f.id) === echo.id)
    ? [...savedFilters, echo]
    : savedFilters;
}

/**
 * Always show the filter dropdown on tabs that support filters, so the UI
 * doesn't shift around when entries arrive (or in Test mode where there'll
 * never be any). "All" is always present; saved filters appear underneath
 * when available.
 *
 * A working filter gets a row of its own, labelled "Custom filter" when the
 * builder made it and by its own name when activating a tag or studio did.
 * Landing on Scenes under a filter with nothing saying which tag caused it
 * reads as the app having a mind of its own — and "Custom filter" would be
 * false.
 */
export function buildFilterOptions(filterMode, controls, filterChoices) {
  if (!filterMode) return null;
  return [
    { value: '', label: 'All' },
    ...(controls.workingFilter
      ? [{
          value: WORKING_FILTER_ID,
          label: controls.workingFilterLabel || 'Custom filter',
        }]
      : []),
    ...filterChoices.map(f => ({ value: String(f.id), label: f.name })),
  ];
}
