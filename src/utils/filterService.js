/**
 * filterService.js — Fetch user-saved filters from Stash.
 *
 * Stash exposes `findSavedFilters(mode)` returning a list of filters
 * the user has saved in the Stash UI. Each saved filter holds:
 *   - find_filter   (q/sort/direction/per_page — pagination & sort)
 *   - object_filter (the typed filter that goes into scene_filter
 *                    / performer_filter / scene_marker_filter)
 *
 * We use only `object_filter` here — sort & paging come from our
 * own ControlsPanel.
 *
 * `object_filter` is returned by Stash as an already-parsed **object**, not a
 * JSON string (this comment claimed otherwise; `parseObjectFilter` below was
 * written to defend against both and does). The object is in Stash's *frontend*
 * shape, which its GraphQL API does not accept — `filterTranslate.js` converts
 * it at query time, in the three service loaders.
 *
 * Results are cached in module scope, keyed by source *and* mode.
 * Switching tabs doesn't re-fetch; switching Stash instance (or
 * Test↔Live) does. A saved filter belongs to exactly one server, so
 * serving the previous source's list would offer filter IDs that
 * don't exist there. `source` is the `version` App.jsx threads
 * through useSavedFilters.
 */

import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';

// SavedFilter modes — must match Stash's FilterMode enum exactly.
//
// Checked against the live enum rather than extended by guesswork: Stash 0.31.1
// declares SCENES, PERFORMERS, STUDIOS, GALLERIES, SCENE_MARKERS, MOVIES,
// GROUPS, TAGS, IMAGES. This app names seven of the nine, and the two it omits
// are omitted because it has no section for them — a mode the app cannot browse
// has no saved filters to offer. (FilterMode is also what decides which saved
// filters the dropdown lists, so a wrong string here shows an empty list rather
// than an error.)
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
// NUL-separated: NUL can occur in neither a FilterMode enum nor a Stash
// URL, so (source, mode) pairs can't collide.
const keyOf = (mode, source) => `${source}\u0000${mode}`;

export async function fetchSavedFilters(mode, source = '') {
  if (!mode) return [];
  if (getSettings().useMock) return [];   // no saved filters in mock mode

  const key = keyOf(mode, source);

  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const p = runQuery(FIND_SAVED_FILTERS_QUERY, { mode })
    .then(data => {
      const list = (data?.findSavedFilters || []).map(f => ({
        id: f.id,
        name: f.name,
        objectFilter: parseObjectFilter(f.object_filter),
        // find_filter holds q/sort/direction/per_page — many saved filters
        // do their actual work via `q` (search) rather than typed criteria.
        findFilter: f.find_filter || null,
      }));
      cache.set(key, list);
      inflight.delete(key);
      return list;
    })
    .catch(err => {
      inflight.delete(key);
      throw err;
    });

  inflight.set(key, p);
  return p;
}

export function getCachedSavedFilters(mode, source = '') {
  return cache.get(keyOf(mode, source)) || null;
}

export function clearSavedFiltersCache() {
  cache.clear();
  inflight.clear();
}

// ── Writing filters back ─────────────────────────────────
//
// Until the builder existed the app could only *read* saved filters; the
// half that creates them has been on the server all along. Both mutations
// live here rather than in the builder so that this file stays the single
// place that names `findSavedFilters` / `saveFilter` / `destroySavedFilter` —
// the same reason the read path is here.

const SAVE_FILTER_MUTATION = `
  mutation SaveFilter($input: SaveFilterInput!) {
    saveFilter(input: $input) {
      id
      name
      find_filter { q page per_page sort direction }
      object_filter
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
 * `id` present means update — Stash's own UI does the same thing through the
 * same mutation, which is why editing a filter the user made in Stash works
 * and does not fork it into a duplicate.
 *
 * `objectFilter` is written in Stash's *stored* envelope (the shape
 * `filterCriteria.js` builds), NOT the GraphQL shape: `object_filter` is the
 * same field the read path parses, so writing GraphQL shape here would produce
 * a filter that Stash's web UI cannot open. `translateFilter` converts on the
 * way out at query time, as it always has.
 *
 * The whole list cache is cleared rather than the one key: a save can create,
 * rename, or reorder, and `saveFilter` returns no position. One extra fetch on
 * a deliberate user action is cheaper than a stale list.
 */
export async function saveFilter({ id, mode, name, objectFilter, findFilter }) {
  const input = { mode, name };
  if (id != null) input.id = String(id);
  if (objectFilter != null) input.object_filter = objectFilter;
  if (findFilter != null) input.find_filter = findFilter;

  const data = await runQuery(SAVE_FILTER_MUTATION, { input });
  clearSavedFiltersCache();
  return data?.saveFilter || null;
}

/**
 * Delete a saved filter. Stash returns a Boolean; a `false` is a real
 * failure (the id no longer exists, or the token lacks permission) and is
 * surfaced rather than swallowed, because the caller has just told the user
 * it worked.
 */
export async function destroySavedFilter(id) {
  const data = await runQuery(DESTROY_FILTER_MUTATION, { input: { id: String(id) } });
  const ok = data?.destroySavedFilter === true;
  if (ok) clearSavedFiltersCache();
  return ok;
}