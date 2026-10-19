/**
 * useActiveFilter — the saved-filter list, the current selection, and the
 * three values the listing tabs actually fetch with.
 *
 * Out of App unchanged apart from the pure rules moving to filterSelection.js.
 * The one subtle piece is `activeObjectFilter`: it is memoized on the
 * resolved filter's *JSON*, not its identity, because `usePagedList` resets
 * on identity and the same saved filter arrives as a fresh object on every
 * refetch.
 */

import { useMemo, useState } from 'react';
import { useSavedFilters } from '../hooks/useSavedFilters.js';
import {
  findActiveFilter, resolveObjectFilter, mergeFilterEcho, buildFilterOptions,
} from '../utils/filterSelection.js';

export function useActiveFilter({ controls, filterMode, dataKey }) {
  // `filtersEpoch` is bumped after a save so the hook's effect re-runs:
  // useSavedFilters has no refresh of its own (it is keyed on mode + source),
  // and `saveFilter` clears the module cache behind it, so re-running is all
  // that is needed to see the new entry. Folding it into `version` also
  // partitions the cache key, which is harmless — the old partition is
  // already cleared by the save.
  const [filtersEpoch, setFiltersEpoch] = useState(0);
  const { filters: savedFilters } = useSavedFilters(filterMode, dataKey, filtersEpoch);

  // The filter just saved, echoed locally until the refetched list carries it.
  // See `filterChoices`.
  const [savedFilterEcho, setSavedFilterEcho] = useState(null);

  // The list the hook delivered, with a just-saved filter's echo standing in
  // until the refetch carries it. See mergeFilterEcho.
  const filterChoices = mergeFilterEcho(savedFilters, savedFilterEcho, filterMode, dataKey);

  // Resolve filterId → objectFilter (the JSON that goes into the
  // GraphQL filter argument). Null when no filter selected or list
  // hasn't loaded yet.
  const activeFilterId = controls.filterId;
  const activeFilter = findActiveFilter(filterChoices, activeFilterId);

  // A hand-built filter beats a saved one; see resolveObjectFilter for why
  // `??` and why no cache invalidation is needed.
  const resolvedObjectFilter = resolveObjectFilter(controls, activeFilter);
  // `usePagedList`'s reset effect keys on this object's *identity*, and the
  // same filter comes back as a fresh object every time the saved-filter list
  // is refetched — each response is parsed anew — and, for a filter that has
  // just been saved, as the echo's object before that. Values unchanged but
  // identity changed throws the rows away and fetches page 1 again. Keying on
  // the JSON, which is what `listCacheKey` keys on too, holds an unchanged
  // filter stable across both.
  const objectFilterJson = JSON.stringify(resolvedObjectFilter);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activeObjectFilter = useMemo(() => resolvedObjectFilter, [objectFilterJson]);

  // `find_filter.q` carries the saved filter's search string — many
  // "filters" in Stash are just a search query.
  // User-typed search overrides any saved filter's bundled `q`.
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
