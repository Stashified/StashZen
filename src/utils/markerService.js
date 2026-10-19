/**
 * markerService.js — Fetch scene markers from Stash GraphQL endpoint
 *
 * A marker holds:
 *   - id, title, seconds (timestamp into the parent scene)
 *   - scene   : parent scene { id, title, ... } — used when activated for playback
 *
 * Activating a marker plays the parent scene's full stream, seeking
 * to `marker.seconds`.
 *
 * The marker's own `stream` — Stash's generated marker-preview file, which the
 * card used to play on focus — is deliberately not requested any more: the
 * card no longer previews, and the file is ungenerated on this server (29 of
 * 30 sampled 404 on 2026-10-15). The marker `preview` field went the same way,
 * except that it does not 404 — see the `screenshot` note in `normalizeMarker`.
 */

import { getSettings } from './settings.js';
import { withApiKey } from './stashUrl.js';
import { runQuery } from './stashQuery.js';
import { createListCache, listCacheKey } from './listCache.js';
import { translateFilter } from './filterTranslate.js';
import { MARKER_PREFIXES, MARKER_SUFFIXES, MARKER_TAGS, mockSceneRef } from './mockLibrary.js';
import { coverArt, makeRng } from './mockArt.js';
import { mockComparator } from './mockSort.js';

// ── Mock generator ────────────────────────────────────────
// Seeded on the marker's id, like the scene generator in videoService.js, so
// a marker keeps its timestamp and its picture across reloads.
function generateMockMarkers(count = 60) {
  return Array.from({ length: count }, (_, i) => {
    const rng = makeRng(`marker-${i}`);
    // Fields that exist for the sort control, from their own stream so the
    // timestamps above stay the fixtures they have always been.
    const extra = makeRng(`marker-sort-${i}`);
    const scene = mockSceneRef(i);

    return {
      id: `marker-${i + 1}`,
      // Twelve prefixes by five suffixes — sixty markers, sixty names.
      title: `${MARKER_PREFIXES[i % MARKER_PREFIXES.length]}`
           + ` ${MARKER_SUFFIXES[Math.floor(i / MARKER_PREFIXES.length) % MARKER_SUFFIXES.length]}`,
      seconds: Math.round(60 + rng() * 3000),
      // The Position group's two sorts. `duration` was a no-op because no
      // mock marker carried one at all; it is the parent scene's length.
      duration: Math.round(300 + extra() * 5400),
      created_at: Date.now() - Math.floor(extra() * 400) * 86400000,
      end_seconds: null,
      screenshot: coverArt(`marker-${i}`),
      primary_tag: { id: `tag-${i % MARKER_TAGS.length}`, name: MARKER_TAGS[i % MARKER_TAGS.length] },
      tags: [],
      // The parent scene, named and identified the same way the scene grid
      // names it — so activating a marker in Test mode lands on a scene that
      // exists rather than on a title nothing else has heard of.
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
    // The parent scene's screenshot wins, and that is the opposite of how this
    // read until 0.6.0 — `m.screenshot || m.scene.screenshot`, with the marker's
    // own frame preferred.
    //
    // The reason for the swap is measured, not stylistic. Stash does not 404 an
    // ungenerated marker screenshot; it answers 200 with a built-in placeholder
    // — a 500x240 black PNG reading "Pending Generate", the same 1199 bytes and
    // the same sha256 for every marker on this server (checked 2026-10-15
    // against all 332, including one on a scene where previews had just been
    // generated). A 200 with a real image in it is indistinguishable here from
    // a 200 with a placeholder, so `||` could never fall through: the marker
    // grid rendered that one graphic for every tile, while a real 1920x1080
    // frame of the parent scene sat unused in the same query.
    //
    // `m.screenshot` stays as the fallback rather than being dropped, so a
    // server that does generate marker frames — and returns something other
    // than the placeholder — still gets used when the scene has no screenshot.
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
      // Carried for the player: a marker on a scene the TV cannot decode has
      // to be re-sourced the same way a card activation does, and App builds
      // this queue item by hand from these fields. See playbackSource.js.
      videoCodec: m.scene?.files?.[0]?.video_codec || null,
      audioCodec: m.scene?.files?.[0]?.audio_codec || null,
      container: m.scene?.files?.[0]?.format || null,
      // And its duration, for the same hand-built-queue reason. Without it a
      // marker-opened scene had `durationSeconds: 0`, which the player reads
      // as "unknown" — so the timeline fell back to the element's (0 for an
      // MP4 transcode) and the resume end threshold was disabled.
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
  return markerCache.get(
    listCacheKey('markers', sort, order, q, page, limit, filter),
    () => loadMarkers({ sort, order, q, page, limit, filter }),
  );
}

/**
 * Drop every cached markers page. Called after a marker is created so the
 * Markers tab shows it. `markerCache` is module-level and therefore survives
 * every remount the app does (including the `dataKey` one that changes the
 * data source), which is exactly why writes have to invalidate it by hand.
 */
export function clearMarkerCache() {
  markerCache.clear();
}

// (this was `fetchMarkers` before the list cache was added)
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

    markers.sort(mockComparator(sort, order));

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
 * Note the two spellings, which are not the same and fail differently —
 * `scene_markers_count` (plural) is the **sort key**, a plain String the
 * resolver validates and rejects with an `errors` entry, while
 * `scene_marker_count` (singular) is the **field**, which GraphQL rejects at
 * validation time if spelled plural. Both verified against the live server.
 *
 * Usage order rather than alphabetical: this library holds 527 tags, a flat
 * list is unusable on a D-pad, and the tag a user reaches for is
 * overwhelmingly one already used across the library. The head is capped —
 * see MARKER_TAG_LIMIT — and the total comes back so a caller can tell the
 * user it is a head rather than the whole library.
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
    // look identical to the user, and the form cannot be completed without a
    // tag. The caller shows this.
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
 * Derived from the markers themselves rather than from the tags: `Tag` has no
 * "last used" field, and the tags' own `created_at` is when the tag was
 * *made*, which for a long-lived tag is years before its last use. Sorting
 * markers by `created_at` DESC and reading off their primary tags is the only
 * ordering here that means "used lately" — verified as a valid sort key on
 * this server, and the spread is real (the oldest marker is 2025-11, the
 * newest 2026-06), so it is a genuine ordering rather than one bulk import's
 * timestamp repeated 331 times.
 *
 * Scans more markers than it returns because consecutive markers routinely
 * share a tag — three of the newest four could be one tag — and a short scan
 * would then yield a "recent" row of two entries.
 *
 * Not cached. `listCache` exists to spare repeated identical page loads; this
 * runs once per form open, which is rare, and its whole value is being current
 * — including picking up a marker created seconds ago, which is also why
 * `clearMarkerCache` would be the wrong instinct here.
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
 * `primary_tag_id` and `title` are both non-null in the input type, so the
 * caller must supply a tag; the caller supplies an empty title and this fills
 * in the tag's name, which is what Stash's own UI does and what it does
 * server-side for an empty title anyway — doing it here means the returned
 * marker is right even if that ever changes.
 *
 * Throws on failure rather than returning a partial result. A create has no
 * prior state to fall back to, so the caller's only correct response to an
 * error is to keep the form open — and it cannot do that if this resolves.
 */
export async function createMarker({ sceneId, seconds, primaryTagId, primaryTagName, title = '' }) {
  if (!sceneId || !primaryTagId) throw new Error('A marker needs a scene and a primary tag');

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
