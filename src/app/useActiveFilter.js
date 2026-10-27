/**
 * useActiveFilter: the saved-filter list, the current selection, and the
 * three values the listing tabs actually fetch with.
 *
 * The subtle piece is `activeObjectFilter`: it is memoised on the resolved
 * filter's *JSON*, not its identity, because `usePagedList` resets on identity
 * and the same saved filter arrives as a fresh object on every refetch.
 */

import { useMemo, useState } from 'react';
import { useSavedFilters } from '../hooks/useSavedFilters.js';
import {
  findActiveFilter, resolveObjectFilter, mergeFilterEcho, buildFilterOptions,
} from '../utils/filterSelection.js';

export function useActiveFilter({ controls, filterMode, dataKey }) {
  // Bumped after a save so the hook's effect re-runs: useSavedFilters is keyed
  // on mode + source and has no refresh of its own, and `saveFilter` clears the
  // module cache behind it. Folding it into `version` also partitions the cache
  // key, which is harmless, the old partition is already cleared.
  const [filtersEpoch, setFiltersEpoch] = useState(0);
  const { filters: savedFilters } = useSavedFilters(filterMode, dataKey, filtersEpoch);

  // The filter just saved, echoed locally until the refetched list carries it
  // (see `filterChoices`).
  const [savedFilterEcho, setSavedFilterEcho] = useState(null);

  // The list the hook delivered, with a just-saved filter's echo standing in
  // until the refetch carries it. See mergeFilterEcho.
  const filterChoices = mergeFilterEcho(savedFilters, savedFilterEcho, filterMode, dataKey);

  // Resolve filterId → objectFilter (the JSON for the GraphQL filter
  // argument); null when none is selected or the list has not loaded yet.
  const activeFilterId = controls.filterId;
  const activeFilter = findActiveFilter(filterChoices, activeFilterId);

  // A hand-built filter beats a saved one; see resolveObjectFilter for why
  // `??` and why no cache invalidation is needed.
  const resolvedObjectFilter = resolveObjectFilter(controls, activeFilter);
  // `usePagedList`'s reset effect keys on this object's *identity*, and the
  // same filter comes back as a fresh object on every refetch, unchanged
  // values would throw the rows away and fetch page 1 again. Keying on the
  // JSON, as `listCacheKey` does, holds it stable.
  const objectFilterJson = JSON.stringify(resolvedObjectFilter);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activeObjectFilter = useMemo(() => resolvedObjectFilter, [objectFilterJson]);

  // `find_filter.q` carries the saved filter's search string, many "filters"
  // are just a search query. User-typed search overrides it.
  const userSearch = controls.search || '';
  const activeSearchQuery = userSearch || activeFilter?.findFilter?.q || '';

  const filterOptions = buildFilterOptions(filterMode, controls, filterChoices);

  return {
    savedFilters,
    filtersEpoch,
    setFiltersEpoch,
    savedFilterEcho,
    setSavedFilterEcho,
    activeFilter,
    activeObjectFilter,
    activeSearchQuery,
    filterOptions,
  };
}
