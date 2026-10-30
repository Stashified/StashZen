/**
 * quickFilters.js: the one-press chips above a listing.
 *
 * A chip is a criterion, not a saved filter: it composes with whatever filter
 * the dropdown has selected and with the other chips, so "Unwatched" can be
 * added to a tag filter without leaving the listing. Criteria are written in
 * GraphQL shape, like useFilteredNavigation's, because this assembles a
 * request; `translateFilter` passes them through untouched.
 *
 * Only fields Stash's own filter types carry are used. Galleries and images
 * have no play count or marker field, so they get the subset their schema
 * supports; see the live probe in scripts/verify-criteria.mjs.
 */

// Stash stores ratings as 0-100. "4+" means 40 and up, expressed as
// GREATER_THAN 39 because the criterion has no inclusive modifier.
const RATED_4_MIN = 39;

export const QUICK_FILTERS = {
  scenes: [
    { id: 'unwatched', label: 'Unwatched' },
    { id: 'rated4', label: 'Rated 4+' },
    { id: 'markers', label: 'Has markers' },
    { id: 'favorites', label: 'Favourite performers' },
    { id: 'addedThisYear', label: 'Added this year' },
  ],
  galleries: [
    { id: 'rated4', label: 'Rated 4+' },
    { id: 'favorites', label: 'Favourite performers' },
    { id: 'addedThisYear', label: 'Added this year' },
  ],
  images: [
    { id: 'rated4', label: 'Rated 4+' },
    { id: 'favorites', label: 'Favourite performers' },
    { id: 'addedThisYear', label: 'Added this year' },
  ],
};

/**
 * One chip as a criterion object, or null for an id this module does not
 * know. `now` is injectable so a test is not written against the wall clock.
 */
export function quickFilterCriterion(id, now = Date.now()) {
  switch (id) {
    case 'unwatched':
      return { play_count: { value: 0, modifier: 'EQUALS' } };
    case 'rated4':
      return { rating100: { value: RATED_4_MIN, modifier: 'GREATER_THAN' } };
    case 'markers':
      return { has_markers: 'true' };
    case 'favorites':
      return { performer_favorite: true };
    case 'addedThisYear': {
      const year = new Date(now).getFullYear();
      const start = Math.floor(new Date(year, 0, 1).getTime() / 1000);
      // TimestampCriterionInput takes the value as a String, not an Int.
      return { created_at: { value: String(start), modifier: 'GREATER_THAN' } };
    }
    default:
      return null;
  }
}

/**
 * The filter the listing fetches with, chips folded into the base.
 *
 * Chips among themselves occupy distinct fields, so they merge. The base can
 * hold any of those fields already (a saved filter with its own rating range),
 * and a top-level merge would replace it; a nested AND is what composes them.
 * Stash validated `{AND: {AND: {...}, ...}}` against 0.31.1.
 *
 * Returns `base` unchanged when no chip applies, so a page with the row
 * untouched keeps the same filter identity.
 */
export function combineQuickFilters(base, defs, ids, now = Date.now()) {
  const known = new Set((defs || []).map(d => d.id));
  const chosen = (ids || []).filter(id => known.has(id));
  if (!chosen.length) return base;

  const chips = {};
  for (const id of chosen) Object.assign(chips, quickFilterCriterion(id, now) || {});
  if (!Object.keys(chips).length) return base;

  const hasBase = base && typeof base === 'object' && Object.keys(base).length > 0;
  if (!hasBase) return chips;
  return { AND: { AND: base, ...chips } };
}
