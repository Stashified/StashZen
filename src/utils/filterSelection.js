/**
 * filterSelection.js: pure rules for turning the controls bar into the
 * listing that gets fetched.
 *
 * Nothing here touches React. Each rule is a distinction that looks like a
 * cleanup and is not, so it is documented where written.
 */

import { WORKING_FILTER_ID } from '../app/tabConfig.js';

/** The saved filter the controls bar's id names, or null. */
export function findActiveFilter(filterChoices, filterId) {
  return filterId
    ? filterChoices.find(f => String(f.id) === String(filterId))
    : null;
}

/**
 * Three states; the ordering is the rule: a hand-built filter beats a saved
 * one, because the builder opens *onto* the current selection and Apply is
 * explicit. `??` not `||` because `{}` is a legitimate "no criteria" filter,
 * and `||` would fall through to the saved filter underneath.
 *
 * No invalidation needed: `listCacheKey` folds in `JSON.stringify(filter)`.
 * The `dataKey` remount stays reserved for a source change.
 */
export function resolveObjectFilter(controls, activeFilter) {
  return controls.workingFilter ?? activeFilter?.objectFilter ?? null;
}

/**
 * `savedFilters` is one epoch behind after a save: `saveBuiltFilter` selects
 * the new id in the same batch that bumps the epoch, so for at least one render
 * the id names nothing, `activeFilter` is null, and the listing flashes the
 * unfiltered library before refetching. The echo stands in for the entry the
 * server is about to return, only while the real list lacks the id, and only
 * for the mode and source that saved it (ids are namespaced per mode/server).
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
 * Always show the dropdown on filter-capable tabs, so the UI does not shift as
 * entries arrive (or in Test mode, where none will). "All" is always present;
 * saved filters appear underneath.
 *
 * A working filter gets its own row: "Custom filter" when the builder made it,
 * its own name when activating a tag or studio did, otherwise landing on
 * Scenes under a filter looks like the app acting on its own.
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
