/**
 * entitySearch.js: name lookup for the filter builder's multi-selects.
 *
 * A criterion stores `{items: [{id, label}]}` (Stash's shape), so the builder
 * needs id→label for whichever entity a field names. Deliberately not the
 * paged services: a picker wants 40 prefix matches, not cached pages with
 * totals, and `usePagedList` would drag the grid machinery into a modal.
 *
 * One table drives all eight sources; the queries differ only in root,
 * argument name and label field. Only id and name are selected, the builder
 * never needs an entity's body to let the user pick one.
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
 * The last `n` segments of a path, joined, the part of a folder path that
 * identifies it.
 *
 * One segment is not enough: gallery folders run
 * `/media/library/<Model>/Photos/<year>`, so the tail alone gives "2002",
 * which several models share. Three gives "Studio Alpha/Photos/2002", or
 * "Summer Shoot/Country House" on a shallower tree. Four would drag the
 * archive root into every label.
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
 * Galleries are why `name` exists: on this server every gallery's `title`,
 * `code` and `date` are empty (200/200 checked), so a title-labelled picker
 * would be a wall of "#101". What identifies a gallery is its folder, so the
 * query pulls `folder.path` and shows its tail. Without this the criterion
 * would be buildable, selectable and useless.
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
    // ScenePathsType has no `basename`, it is `screenshot`/`preview`/`stream`
    // /`webp`/`vtt`/`sprite`/`funscript`/`interactive_heatmap`/`caption`. The
    // file's own basename is on the scene, under `files`.
    select: 'id title files { basename }',
    name: (r) => r.title || lastSegment(r.files?.[0]?.basename),
  },
  // Galleries' `parent_folder` and `folders_filter` criteria are folder
  // records; without this source the picker queried nothing and claimed the
  // library had none. `findFolders` takes `folder_filter` and returns
  // `folders { id basename path }`, with `basename` a valid sort key.
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
// The builder is reachable in Test mode too; a short list of obvious fakes
// beats a picker that opens onto an error.
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
 * `q` is Stash's free-text filter, not a criterion: a picker input is a name
 * fragment, which is what `q` already matches.
 *
 * Returns `[{id, label}]` capped at `limit`; an unknown entity yields nothing
 * (ask `isSearchable` first) rather than throwing.
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
 * Saved filters store their own labels, so this only fills in a missing or
 * stale one (entity renamed or deleted), where the raw id beats nothing.
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
