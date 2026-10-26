/**
 * markerService.js — fetch scene markers from the Stash GraphQL endpoint.
 *
 * A marker holds id, title and `seconds` (a timestamp into the parent scene),
 * plus its parent `scene`. Activating it plays that scene in full, seeking to
 * `marker.seconds`.
 *
 * The marker's own `stream` (a generated preview) is deliberately not
 * requested: cards no longer preview, and it is usually ungenerated on this
 * server (29 of 30 sampled 404). `preview` likewise; see `normalizeMarker`.
 */

import { getSettings } from './settings.js';
import { withApiKey } from './stashUrl.js';
import { runQuery } from './stashQuery.js';
import { createListCache, listCacheKey } from './listCache.js';
import { translateFilter } from './filterTranslate.js';
import { MARKER_PREFIXES, MARKER_SUFFIXES, MARKER_TAGS, mockSceneRef } from './mockLibrary.js';
import { coverArt, makeRng } from './mockArt.js';
import { mockComparator } from './mockSort.js';
import { baseSort, stableSort } from './randomSort.js';

// ── Mock generator ────────────────────────────────────────
// Seeded on the marker's id, like the scene generator in videoService.js, so
// a marker keeps its timestamp and its picture across reloads.
function generateMockMarkers(count = 60) {
  return Array.from({ length: count }, (_, i) => {
    const rng = makeRng(`marker-${i}`);
    // Sort-control fields use their own stream so the timestamps above stay
    // the fixtures they have always been.
    const extra = makeRng(`marker-sort-${i}`);
    const scene = mockSceneRef(i);

    return {
      id: `marker-${i + 1}`,
      // Twelve prefixes by five suffixes — sixty markers, sixty names.
      title: `${MARKER_PREFIXES[i % MARKER_PREFIXES.length]}`
           + ` ${MARKER_SUFFIXES[Math.floor(i / MARKER_PREFIXES.length) % MARKER_SUFFIXES.length]}`,
      seconds: Math.round(60 + rng() * 3000),
      // The Position group's sorts; `duration` is the parent scene's length.
      duration: Math.round(300 + extra() * 5400),
      created_at: Date.now() - Math.floor(extra() * 400) * 86400000,
      end_seconds: null,
      screenshot: coverArt(`marker-${i}`),
      primary_tag: { id: `tag-${i % MARKER_TAGS.length}`, name: MARKER_TAGS[i % MARKER_TAGS.length] },
      tags: [],
      // Named and identified as the scene grid does it, so activating a marker
      // in Test mode lands on a scene that exists.
      scene: { ...scene, performers: [] },
    };
  });
}

// ── GraphQL query ─────────────────────────────────────────
const FIND_MARKERS_QUERY = `
  query FindSceneMarkers($filter: FindFilterType, $scene_marker_filter: SceneMarkerFilterType) {
    findSceneMarkers(filter: $filter, scene_marker_filter: $scene_marker_filter) {
      count
      scene_markers {
        id
        title
        seconds
        end_seconds
        screenshot
        scene {
          id
          title
          paths { stream screenshot sprite vtt }
          files { video_codec audio_codec format duration }
          performers { name }
        }
        primary_tag { name }
        tags { name }
      }
    }
  }
`;

function normalizeMarker(m) {
  return {
    id: m.id,
    title: m.title || m.primary_tag?.name || 'Untitled marker',
    seconds: m.seconds || 0,
    endSeconds: m.end_seconds || null,
    // The parent scene's screenshot wins. Stash answers an ungenerated marker
    // screenshot with a 200, not a 404: a 500x240 black "Pending Generate" PNG,
    // the same 1199 bytes for every marker on this server. A 200 is
    // indistinguishable from a real image, so `||` could never fall through and
    // every tile rendered that graphic. `m.screenshot` stays as the fallback
    // for servers that do generate real marker frames.
    screenshot: withApiKey(m.scene?.paths?.screenshot || m.screenshot) || null,
    primaryTag: m.primary_tag?.name || null,
    tags: m.tags?.map(t => t.name) || [],
    scene: {
      id: m.scene?.id,
      title: m.scene?.title || `Scene ${m.scene?.id}`,
      stream: withApiKey(m.scene?.paths?.stream) || null,   // ← used for full playback
      screenshot: withApiKey(m.scene?.paths?.screenshot) || null,
      sprite: withApiKey(m.scene?.paths?.sprite) || null,   // ← skim preview sheet
      vtt: withApiKey(m.scene?.paths?.vtt) || null,         // ← skim preview cue map
      // Carried for the player: App builds this queue item by hand, and a
      // marker on an undecodable scene must be re-sourced like a card
      // activation. See playbackSource.js.
      videoCodec: m.scene?.files?.[0]?.video_codec || null,
      audioCodec: m.scene?.files?.[0]?.audio_codec || null,
      container: m.scene?.files?.[0]?.format || null,
      // Duration, for the same reason: without it a marker-opened scene has
      // `durationSeconds: 0`, which the player reads as "unknown" — the
      // timeline falls back to the element's (0 for an MP4 transcode) and the
      // resume end threshold is disabled.
      durationSeconds: m.scene?.files?.[0]?.duration || 0,
      performers: m.scene?.performers?.map(p => p.name) || [],
    },
  };
}

// ═══════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════
const markerCache = createListCache();

/** Cached page fetch — see the note on fetchVideos in videoService.js. */
export async function fetchMarkers({
  sort = 'title',
  order = 'asc',
  q = '',
  page = 1,
  limit = 40,
  filter = null,
} = {}) {
  // Seeded per request identity, not per page — see videoService.fetchVideos
  // and randomSort.js.
  const requestSort = stableSort(sort, 'markers', filter, q);
  return markerCache.get(
    listCacheKey('markers', requestSort, order, q, page, limit, filter),
    () => loadMarkers({ sort: requestSort, order, q, page, limit, filter }),
  );
}

/**
 * Drop every cached markers page, called after a marker is created.
 * `markerCache` is module-level and survives every remount (including the
 * `dataKey` one that changes the data source), so writes must invalidate it.
 */
export function clearMarkerCache() {
  markerCache.clear();
}

async function loadMarkers({
  sort = 'title',
  order = 'asc',
  q = '',
  page = 1,
  limit = 40,
  filter = null,
} = {}) {
  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 400));
    let markers = generateMockMarkers(60);

    // `sort` may be `random_<n>`; the comparator knows only `random`.
    markers.sort(mockComparator(baseSort(sort), order));

    const start = (page - 1) * limit;
    const slice = markers.slice(start, start + limit).map(normalizeMarker);
    return { markers: slice, total: markers.length, page };
  }

  const variables = {
    filter: {
      q,
      page,
      per_page: limit,
      sort,
      direction: order === 'asc' ? 'ASC' : 'DESC',
    },
    // Translated at query time — see the note in videoService.js.
    scene_marker_filter: translateFilter(filter, 'SceneMarkerFilterType'),
  };

  const data = await runQuery(FIND_MARKERS_QUERY, variables);
  const markers = data?.findSceneMarkers?.scene_markers || [];

  return {
    markers: markers.map(normalizeMarker),
    total: data?.findSceneMarkers?.count || 0,
    page,
  };
}

// ═══════════════════════════════════════════════════════════
// TAG OPTIONS FOR THE CREATE FORM
// ═══════════════════════════════════════════════════════════

const FIND_TAGS_QUERY = `
  query FindTags($filter: FindFilterType) {
    findTags(filter: $filter) {
      count
      tags {
        id
        name
        # Singular field, plural sort key — see the note below. Getting these
        # the same way round is a validation error either way.
        scene_marker_count
      }
    }
  }
`;

/**
 * The tags worth offering in the marker form: the most-used ones, in order.
 *
 * Two spellings, which fail differently: `scene_markers_count` (plural) is the
 * **sort key**, a plain String validated and rejected with an `errors` entry;
 * `scene_marker_count` (singular) is the **field**, which GraphQL rejects if
 * spelled plural.
 *
 * Usage order, not alphabetical: this library holds 527 tags, a flat list is
 * unusable on a D-pad, and the wanted tag is overwhelmingly one already used.
 * The head is capped (MARKER_TAG_LIMIT) and the total returned so a caller can
 * say it is a head, not the whole library.
 */
export const MARKER_TAG_LIMIT = 60;

export async function fetchTagOptions(limit = MARKER_TAG_LIMIT) {
  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 200));
    return {
      tags: MARKER_TAGS.slice(0, limit).map((name, i) => ({
        id: `tag-${i}`,
        name,
        markerCount: 8 - i,
      })),
      total: 527,
    };
  }

  try {
    const data = await runQuery(FIND_TAGS_QUERY, {
      filter: { page: 1, per_page: limit, sort: 'scene_markers_count', direction: 'DESC' },
    });
    return {
      tags: (data?.findTags?.tags || []).map(t => ({
        id: t.id,
        name: t.name,
        markerCount: t.scene_marker_count || 0,
      })),
      total: data?.findTags?.count || 0,
    };
  } catch (e) {
    // Not swallowed into an empty list: an empty picker and a failed request
    // look identical, and the form cannot be completed without a tag.
    console.warn('[fetchTagOptions] failed:', e.message);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════
// RECENTLY USED TAGS
// ═══════════════════════════════════════════════════════════

const RECENT_TAGS_QUERY = `
  query RecentMarkerTags($filter: FindFilterType) {
    findSceneMarkers(filter: $filter) {
      scene_markers {
        primary_tag { id name }
      }
    }
  }
`;

/**
 * The tags this library has actually been marking with lately, newest first.
 *
 * Derived from the markers, not the tags: `Tag` has no "last used" field, and a
 * tag's `created_at` is when it was *made*, years before its last use. Sorting
 * markers by `created_at` DESC and reading off primary tags is the only
 * ordering that means "used lately"; this is a valid sort key on this server.
 *
 * Scans more markers than it returns because consecutive markers routinely
 * share a tag, so a short scan could yield a "recent" row of two entries.
 *
 * Not cached: it runs once per form open and its whole value is being current,
 * including a marker created seconds ago — so `clearMarkerCache` would be the
 * wrong instinct here.
 */
export const MARKER_RECENT_TAG_LIMIT = 12;
const RECENT_TAG_SCAN = 60;

export async function fetchRecentMarkerTags(limit = MARKER_RECENT_TAG_LIMIT) {
  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 150));
    // Same ids as fetchTagOptions' mock so the two rows agree in mock mode —
    // which is also where the real duplicate-chip case gets exercised.
    return MARKER_TAGS.slice(0, 4).map((name, i) => ({ id: `tag-${i}`, name }));
  }

  const data = await runQuery(RECENT_TAGS_QUERY, {
    filter: { page: 1, per_page: RECENT_TAG_SCAN, sort: 'created_at', direction: 'DESC' },
  });

  const seen = new Set();
  const recent = [];
  for (const m of data?.findSceneMarkers?.scene_markers || []) {
    const tag = m.primary_tag;
    if (!tag?.id || seen.has(tag.id)) continue;
    seen.add(tag.id);
    recent.push({ id: tag.id, name: tag.name });
    if (recent.length >= limit) break;
  }
  return recent;
}

// ═══════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════

const SCENE_MARKER_CREATE_MUTATION = `
  mutation SceneMarkerCreate($input: SceneMarkerCreateInput!) {
    sceneMarkerCreate(input: $input) {
      id
      seconds
      primary_tag { id name }
    }
  }
`;

/**
 * Create a marker at `seconds` on a scene.
 *
 * `primary_tag_id` and `title` are both non-null in the input type. The caller
 * supplies an empty title and this fills in the tag's name, as Stash's UI does;
 * doing it here keeps the returned marker right even if the server changes.
 *
 * Throws rather than returning a partial result: a create has no prior state
 * to fall back to, and the caller's only correct response to an error is to
 * keep the form open — impossible if this resolves.
 */
// Test mode has no server, so a created marker is only an id for the player to
// merge into the scene it is showing; it is not persisted anywhere.
let mockMarkerSeq = 0;

export async function createMarker({ sceneId, seconds, primaryTagId, primaryTagName, title = '' }) {
  if (!sceneId || !primaryTagId) throw new Error('A marker needs a scene and a primary tag');

  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 250));
    return {
      id: `marker-created-${++mockMarkerSeq}`,
      seconds: Number(seconds) || 0,
      primaryTag: { id: primaryTagId, name: primaryTagName || null },
    };
  }

  const data = await runQuery(SCENE_MARKER_CREATE_MUTATION, {
    input: {
      scene_id: String(sceneId),
      seconds: Number(seconds) || 0,
      // Null: a point marker. Ranged markers exist (Stash's own UI has a
      // shift-click mode) and are not part of this form.
      end_seconds: null,
      primary_tag_id: String(primaryTagId),
      title: title.trim() || primaryTagName || '',
    },
  });

  const created = data?.sceneMarkerCreate;
  if (!created?.id) throw new Error('Stash did not return the new marker');

  // The Markers tab lists from a module-level cache that a write cannot see
  // into, so the page would otherwise still be missing this marker.
  clearMarkerCache();

  return {
    id: created.id,
    seconds: created.seconds || Number(seconds) || 0,
    primaryTag: { id: created.primary_tag?.id, name: created.primary_tag?.name || primaryTagName || null },
  };
}
