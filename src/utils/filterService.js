/**
 * filterService.js: Fetch user-saved filters from Stash.
 *
 * `findSavedFilters(mode)` returns filters the user saved in the Stash UI:
 *   - find_filter   (q/sort/direction/per_page, pagination & sort)
 *   - object_filter (the typed filter for scene_filter / performer_filter / …)
 *
 * Only `object_filter` is used here, sort and paging come from our own
 * ControlsPanel. Stash returns it as an already-parsed **object** in its
 * *frontend* shape, which its GraphQL API does not accept; `filterTranslate.js`
 * converts at query time in the service loaders.
 *
 * Results are cached in module scope, keyed by source *and* mode. Switching
 * tabs doesn't re-fetch; switching instance (or Test↔Live) does, because a
 * saved filter belongs to one server and serving another's would offer ids
 * that don't exist there. `source` is the `version` App.jsx threads through
 * useSavedFilters.
 */

import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';

// SavedFilter modes, must match Stash's FilterMode enum exactly. Stash 0.31.1
// declares SCENES, PERFORMERS, STUDIOS, GALLERIES, SCENE_MARKERS, MOVIES,
// GROUPS, TAGS, IMAGES; this app omits the two with no section (a mode it
// cannot browse has no filters to offer). A wrong string shows an empty list,
// not an error.
export const FILTER_MODE = {
  scenes:     'SCENES',
  markers:    'SCENE_MARKERS',
  performers: 'PERFORMERS',
  tags:       'TAGS',
  studios:    'STUDIOS',
  galleries:  'GALLERIES',
  images:     'IMAGES',
};

const FIND_SAVED_FILTERS_QUERY = `
  query FindSavedFilters($mode: FilterMode) {
    findSavedFilters(mode: $mode) {
      id
      name
      find_filter { q page per_page sort direction }
      object_filter
      ui_options
    }
  }
`;

// `object_filter` may come back as a JSON string OR as an already-parsed
// object depending on Stash version / scalar handling. Normalise both.
function parseObjectFilter(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
}

// ── Cache ────────────────────────────────────────────────
const cache = new Map();   // key → [{ id, name, objectFilter }]
const inflight = new Map();// key → Promise
// Bumped by `clearSavedFiltersCache`: a fetch in flight at that moment must
// not cache its stale result. Same guard as `listCache.js`.
let generation = 0;
// NUL-separated: NUL can occur in neither a FilterMode enum nor a Stash
// URL, so (source, mode) pairs can't collide.
const keyOf = (mode, source) => `${source}\u0000${mode}`;

export async function fetchSavedFilters(mode, source = '') {
  if (!mode) return [];
  if (getSettings().useMock) return [];   // no saved filters in mock mode

  const key = keyOf(mode, source);

  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const gen = generation;
  // Delete our own promise, not whatever holds the key: after a clear, a newer
  // request may already have taken the slot.
  const settle = () => {
    if (inflight.get(key) === p) inflight.delete(key);
  };
  const p = runQuery(FIND_SAVED_FILTERS_QUERY, { mode })
    .then(data => {
      const list = (data?.findSavedFilters || []).map(f => ({
        id: f.id,
        name: f.name,
        objectFilter: parseObjectFilter(f.object_filter),
        // find_filter holds q/sort/direction/per_page, many saved filters
        // do their actual work via `q` (search) rather than typed criteria.
        findFilter: f.find_filter || null,
        // Stash stores display options (columns, etc.) beside the filter. An
        // update overwrites the whole row, so they must travel back on save.
        uiOptions: f.ui_options ?? null,
      }));
      settle();
      if (gen === generation) cache.set(key, list);
      return list;
    })
    .catch(err => {
      settle();
      throw err;
    });

  inflight.set(key, p);
  return p;
}

export function clearSavedFiltersCache() {
  generation++;
  cache.clear();
  inflight.clear();
}

// ── Writing filters back ─────────────────────────────────
//
// Both mutations live here so this file stays the single place naming
// `findSavedFilters` / `saveFilter` / `destroySavedFilter`.

const SAVE_FILTER_MUTATION = `
  mutation SaveFilter($input: SaveFilterInput!) {
    saveFilter(input: $input) {
      id
      name
      find_filter { q page per_page sort direction }
      object_filter
      ui_options
    }
  }
`;

const DESTROY_FILTER_MUTATION = `
  mutation DestroySavedFilter($input: DestroyFilterInput!) {
    destroySavedFilter(input: $input)
  }
`;

/**
 * Create or update a saved filter.
 *
 * `id` present means update, the same mutation Stash's own UI uses, so
 * editing a user-made filter works and does not fork it into a duplicate.
 *
 * `objectFilter` is written in Stash's *stored* envelope, the shape Stash's own
 * UI persists. Text criteria happen to match the GraphQL shape, but
 * multi-selects nest `items`/`excluded`; writing the request shape for those
 * produces a filter Stash's web UI cannot open. `translateFilter` converts on
 * the way out.
 *
 * The whole list cache is cleared rather than one key: a save can create,
 * rename or reorder, and `saveFilter` returns no position. One extra fetch on
 * a deliberate user action is cheaper than a stale list.
 */
export async function saveFilter({ id, mode, name, objectFilter, findFilter, uiOptions }) {
  const input = { mode, name };
  if (id != null) input.id = String(id);
  if (objectFilter != null) input.object_filter = objectFilter;
  if (findFilter != null) input.find_filter = findFilter;
  // The update replaces the whole row; dropping this resets Stash's display
  // options for the filter.
  if (uiOptions != null) input.ui_options = uiOptions;

  const data = await runQuery(SAVE_FILTER_MUTATION, { input });
  clearSavedFiltersCache();
  return data?.saveFilter || null;
}

/** Delete a saved filter. A `false` return (id gone, or token lacks
 *  permission) is surfaced, not swallowed, the caller has just told the user
 *  it worked. */
export async function destroySavedFilter(id) {
  const data = await runQuery(DESTROY_FILTER_MUTATION, { input: { id: String(id) } });
  const ok = data?.destroySavedFilter === true;
  if (ok) clearSavedFiltersCache();
  return ok;
}