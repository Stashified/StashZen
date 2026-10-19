/**
 * entitySearch.js — name lookup for the filter builder's multi-selects.
 *
 * A multi-select criterion stores `{items: [{id, label}]}` — Stash's own shape
 * — so the builder needs id→label for whichever entity a field names. This is
 * deliberately *not* the paged listing services: a picker wants 40 rows that
 * match a typed prefix, not a cached, sorted, filterable page with a total,
 * and putting it through `usePagedList` would drag the whole grid machinery
 * into a modal.
 *
 * One table drives all eight sources, because the queries differ only in the
 * root, the argument name and the label field — the same reason
 * `filterCriteria.js` derives its editors from the schema rather than listing
 * fields.
 *
 * The app's other services select full entity shapes for a grid to render.
 * These select an id and a name and nothing else, which is also the
 * conservatism the project's probing rule asks for: the builder never needs
 * the body of a performer to let the user pick one.
 */

import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';
import { STUDIOS, mockPersonName } from './mockLibrary.js';

/** The last non-empty segment of a path. */
function lastSegment(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * The last `n` segments of a path, joined — the part of a folder path that
 * identifies it.
 *
 * One segment is not enough on this library: gallery folders run
 * `/media/library/<Model>/Photos/<year>`, so the tail segment alone gives
 * "2002", which several models share. Three gives "Studio Alpha/Photos/2002"
 * — and on a shallower tree, "Summer Shoot/Country House" — which is what the
 * user would recognise. Four would start dragging the archive root into every
 * label.
 */
function tailSegments(path, n = 3) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.slice(Math.max(0, parts.length - n)).join('/');
}

/**
 * entity key → how to query it and how to name a row.
 *
 * `label` is the GraphQL field to *sort* and select; `name(row)` turns the row
 * into what the user reads.
 *
 * Galleries are why `name` exists at all. On this server every gallery's
 * `title`, `code` and `date` are empty — measured, not assumed: the first 200
 * sorted by title are blank, 200 of 200. A picker labelling them by title
 * would be a wall of "#101", "#102", "#2938". What actually identifies a
 * gallery is the folder it lives in, so the query pulls `folder.path` and
 * shows its last segment. Without this the gallery criterion would be
 * buildable, selectable, and useless.
 */
const SOURCES = {
  tags: {
    root: 'findTags', rows: 'tags', label: 'name',
    select: 'id name',
    name: (r) => r.name,
  },
  performers: {
    root: 'findPerformers', rows: 'performers', label: 'name',
    select: 'id name',
    name: (r) => r.name,
  },
  studios: {
    root: 'findStudios', rows: 'studios', label: 'name',
    select: 'id name',
    name: (r) => r.name,
  },
  galleries: {
    root: 'findGalleries', rows: 'galleries', label: 'title',
    select: 'id title folder { path }',
    name: (r) => r.title || tailSegments(r.folder?.path),
  },
  movies: {
    root: 'findMovies', rows: 'movies', label: 'name',
    select: 'id name',
    name: (r) => r.name,
  },
  groups: {
    root: 'findGroups', rows: 'groups', label: 'name',
    select: 'id name',
    name: (r) => r.name,
  },
  scenes: {
    root: 'findScenes', rows: 'scenes', label: 'title',
    // ScenePathsType has no `basename` — it is `screenshot`/`preview`/`stream`
    // /`webp`/`vtt`/`sprite`/`funscript`/`interactive_heatmap`/`caption`. The
    // file's own basename is on the scene, under `files`.
    select: 'id title files { basename }',
    name: (r) => r.title || lastSegment(r.files?.[0]?.basename),
  },
  // Galleries carry `parent_folder` and `folders_filter` as hierarchical
  // criteria, and those records are folders. Without this source the picker
  // opened, queried nothing (no entry meant `searchEntities` returned an empty
  // list), and said "this library has none" — a criterion that could never be
  // given a value. Verified on the live 0.31.1 schema: `findFolders` takes
  // `folder_filter` and returns `folders { id basename path }`, and
  // `basename` is a valid sort key there.
  folders: {
    root: 'findFolders', rows: 'folders', label: 'basename',
    select: 'id basename path',
    // The tail of the path, for the same reason galleries use it: a folder's
    // basename is often a year ("2002") that several models share.
    name: (r) => tailSegments(r.path) || r.basename,
  },
};

const FILTER_ARG = {
  tags: 'tag_filter', performers: 'performer_filter', studios: 'studio_filter',
  galleries: 'gallery_filter', movies: 'movie_filter', groups: 'group_filter',
  scenes: 'scene_filter', folders: 'folder_filter',
};

/** Entities the picker can offer. */
export function isSearchable(entity) {
  return Object.prototype.hasOwnProperty.call(SOURCES, entity);
}

// ── Mock ──────────────────────────────────────────────────
//
// Test mode has no saved filters, so nothing here is load-bearing for the
// existing screens — but the builder is reachable in Test mode too, and a
// picker that opens onto an error would be a worse answer than a short list
// of obvious fakes.
function mockRows(entity, q) {
  const names = {
    tags: Array.from({ length: 30 }, (_, i) => `Tag ${i + 1}`),
    performers: Array.from({ length: 30 }, (_, i) => mockPersonName(i)),
    studios: [...STUDIOS],
    galleries: Array.from({ length: 20 }, (_, i) => `Gallery ${i + 1}`),
    movies: Array.from({ length: 20 }, (_, i) => `Movie ${i + 1}`),
    groups: Array.from({ length: 12 }, (_, i) => `Group ${i + 1}`),
    scenes: Array.from({ length: 20 }, (_, i) => `Scene ${i + 1}`),
    folders: Array.from({ length: 20 }, (_, i) => `Folder ${i + 1}`),
  }[entity] || [];

  const needle = q.trim().toLowerCase();
  return names
    .map((name, i) => ({ id: String(i + 1), label: name }))
    .filter(r => !needle || r.label.toLowerCase().includes(needle))
    .slice(0, 40);
}

// ── Public ────────────────────────────────────────────────

/**
 * Search one entity kind by name.
 *
 * `q` is passed as Stash's free-text filter rather than a criterion: what the
 * user types in a picker is a name fragment, and Stash's own `q` already means
 * "match this against the entity's name".
 *
 * Returns `[{id, label}]`, capped at `limit`. Never throws for an unknown
 * entity — it returns nothing, and `isSearchable` is how a caller asks first.
 */
export async function searchEntities(entity, q = '', limit = 40) {
  const src = SOURCES[entity];
  if (!src) return [];

  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 120));
    return mockRows(entity, q);
  }

  const query = `
    query SearchEntities($filter: FindFilterType, $entity_filter: ${entityFilterType(entity)}) {
      ${src.root}(filter: $filter, ${FILTER_ARG[entity]}: $entity_filter) {
        count
        ${src.rows} { ${src.select} }
      }
    }
  `;

  const data = await runQuery(query, {
    filter: { q, page: 1, per_page: limit, sort: src.label, direction: 'ASC' },
    entity_filter: {},
  });

  const rows = data?.[src.root]?.[src.rows] || [];
  return rows.map((r) => {
    const label = src.name(r);
    // An empty label is a real possibility (a gallery with no title and no
    // folder path). Showing the id is worse than showing the name and better
    // than showing nothing the user can tell apart.
    return { id: String(r.id), label: label || `#${r.id}` };
  });
}

/**
 * Resolve `[{id, label}]` for ids the builder already holds.
 *
 * A saved filter stores its own labels, so reopening one needs no lookup at
 * all — this exists for the case where a label is missing or stale (an entity
 * renamed or deleted since the filter was saved), where showing the raw id is
 * better than showing nothing.
 */
export function labelForIds(items) {
  return (items || []).map(i => ({
    id: String(i.id),
    label: i.label || `#${i.id}`,
  }));
}

/** The GraphQL filter-type name for an entity, e.g. tags → TagFilterType. */
function entityFilterType(entity) {
  return {
    tags: 'TagFilterType',
    performers: 'PerformerFilterType',
    studios: 'StudioFilterType',
    galleries: 'GalleryFilterType',
    movies: 'MovieFilterType',
    groups: 'GroupFilterType',
    scenes: 'SceneFilterType',
    folders: 'FolderFilterType',
  }[entity];
}
