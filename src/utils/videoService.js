/**
 * videoService.js — fetch scenes from a Stash GraphQL endpoint.
 *
 * URL, API key and Test/Live mode are read at request time from the settings
 * store so the user can configure them at runtime.
 *
 * Sort keys pass straight through to Stash — UI keys MUST match Stash's GraphQL
 * sort enum values (created_at, title, rating, etc).
 */

import { getSettings } from './settings.js';
import { withApiKey } from './stashUrl.js';
import { runQuery } from './stashQuery.js';
import { createListCache, listCacheKey } from './listCache.js';
import { translateFilter } from './filterTranslate.js';
import { SCENE_TITLES, STUDIOS } from './mockLibrary.js';
import { coverArt, makeRng } from './mockArt.js';
import { mockComparator } from './mockSort.js';
import { baseSort, stableSort } from './randomSort.js';

// The two scene sort values whose mock field has another name: `duration` is
// the card's formatted string (seconds live in `durationSeconds`), and
// `resolution`, a server enum, is best approximated by pixel height.
const MOCK_SORT_ALIAS = {
  duration: 'durationSeconds',
  resolution: 'height',
};

// ═══════════════════════════════════════════════════════════
// CONFIG (resolved per-request from settings)
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// MOCK DATA (Test mode — see mockLibrary.js and mockArt.js)
// ═══════════════════════════════════════════════════════════
// Everything below is invented but stable: a PRNG seeded on the scene's id, so
// a scene keeps its duration, rating and cover while the app is in Test mode.
// That is what makes a layout change comparable before and after.
function generateMockVideos(count = 48) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const rng = makeRng(`scene-${i}`);
    const seconds = Math.round(180 + rng() * 5400);        // 3 min to ~1h33
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    const plays = Math.floor(rng() * 14);
    const height = [2160, 1080, 1080, 720, 480][Math.floor(rng() * 5)];
    const bitrate = Math.round(height * (1.6 + rng() * 3.4));   // kbps

    return {
      id: `vid-${i + 1}`,
      title: SCENE_TITLES[i % SCENE_TITLES.length],
      duration: hours ? `${hours}h ${minutes}m` : `${minutes}m`,
      durationSeconds: seconds,
      year: 1962 + Math.floor(rng() * 60),
      date: 1962 + Math.floor(rng() * 60),
      created_at: now - i * 86400000,
      updated_at: now - i * 43200000,
      // Some scenes are unrated and some never watched: a card renders both
      // states, and Test mode is where the difference gets looked at.
      rating: rng() > 0.25 ? (rng() * 3.5 + 6).toFixed(1) : null,
      o_counter: rng() > 0.6 ? Math.floor(rng() * 9) : 0,
      play_count: plays,
      play_duration: plays ? Math.round(seconds * rng() * plays) : 0,
      // Only watched scenes carry a position, and only some of those are far
      // enough in for the card's resume bar to have something to draw.
      resume_time: plays && rng() > 0.3 ? Math.round(seconds * (0.05 + rng() * 0.8)) : 0,
      last_played_at: plays ? now - Math.floor(rng() * 40) * 86400000 : null,
      filesize: Math.round((bitrate * 1000 * seconds) / 8),
      height,
      bitrate,
      framerate: [24, 25, 30][Math.floor(rng() * 3)],
      performer_age: 21 + Math.floor(rng() * 25),
      category: STUDIOS[i % STUDIOS.length],
      thumbnail: coverArt(`scene-${i}`),
      stream: null,
      sprite: null,
      vtt: null,
      preview: null,
    };
  });
}

// ═══════════════════════════════════════════════════════════
// GRAPHQL
// ═══════════════════════════════════════════════════════════
const FIND_SCENES_QUERY = `
  query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
    findScenes(filter: $filter, scene_filter: $scene_filter) {
      count
      scenes {
        id
        title
        date
        rating100
        play_count
        files {
          duration
          width
          height
          video_codec
          audio_codec
          format
        }
        resume_time
        paths {
          screenshot
          stream
          sprite
          vtt
          preview
        }
        studio {
          id
          name
        }
        tags {
          id
          name
        }
        performers {
          id
          name
        }
      }
    }
  }
`;

function formatDuration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The release year, read off the date string.
 *
 * `date` is date-only ("2019-05-04"), which `new Date()` parses as UTC
 * midnight, so `getFullYear()` west of Greenwich answers the year before. The
 * year is the first four characters; do not parse a Date.
 */
function yearOf(date) {
  const m = /^(\d{4})/.exec(date || '');
  return m ? Number(m[1]) : null;
}

function normalizeScene(scene) {
  const file = scene.files?.[0];
  const duration = file?.duration || 0;
  const year = yearOf(scene.date);

  return {
    id: scene.id,
    title: scene.title || `Scene ${scene.id}`,
    duration: formatDuration(duration),
    durationSeconds: duration,
    year,
    rating: scene.rating100 != null ? (scene.rating100 / 10).toFixed(1) : null,
    category: scene.studio?.name || scene.tags?.[0]?.name || 'Untagged',
    // Every one of these except `stream` arrives without the API key;
    // withApiKey is a no-op on `stream`.
    //
    // `preview` is non-empty for *every* scene, even with no preview file, so
    // a card must not trust it alone: VideoCard treats the <video> element as
    // its probe and keeps the cover until a frame arrives. See its header.
    thumbnail: withApiKey(scene.paths?.screenshot) || null,
    stream: withApiKey(scene.paths?.stream) || null,
    sprite: withApiKey(scene.paths?.sprite) || null,
    vtt: withApiKey(scene.paths?.vtt) || null,
    preview: withApiKey(scene.paths?.preview) || null,
    play_count: scene.play_count || 0,
    studio: scene.studio?.name,
    performers: scene.performers?.map(p => p.name) || [],
    tags: scene.tags?.map(t => t.name) || [],
    width: file?.width,
    height: file?.height,
    // Carried for the *player*, not the card: see playbackSource.js for how
    // these decide a transcode, and why "unknown" differs from "known bad".
    videoCodec: file?.video_codec || null,
    audioCodec: file?.audio_codec || null,
    container: file?.format || null,
    resume_time: scene.resume_time || 0,
  };
}

// ═══════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════
const sceneCache = createListCache();

/**
 * Drop every cached scene page. Anything that changes what a grid card draws
 * — a resume position, a rating, a like — has to call this, or the grid keeps
 * serving the page it fetched before the change.
 */
export function clearScenePages() {
  sceneCache.clear();
}

/**
 * Cached page fetch. Switching tabs or returning to a sort already seen renders
 * from here instead of re-showing the spinner — the request is only ~28 ms, so
 * the win is perceived, not wall-clock.
 *
 * The key carries the full request identity, and listCacheKey folds in the
 * data source, so Test and Live cannot serve each other's pages.
 *
 * `mode` is Test-mode only: it filters the mock library and feeds the random
 * seed; the GraphQL branch ignores it.
 */
export async function fetchVideos({
  mode = 'all',
  sort = 'created_at',
  order = 'desc',
  filter = null,
  q = '',
  page = 1,
  limit = 40,
} = {}) {
  // `random` re-shuffles server-side on every request, so page 2 would overlap
  // page 1 and the no-progress stop could end a short list early. Seed from the
  // listing's identity, never the page number. See randomSort.js.
  const requestSort = stableSort(sort, 'scenes', mode, filter, q);
  return sceneCache.get(
    listCacheKey('scenes', mode, requestSort, order, filter, q, page, limit),
    () => loadVideos({ mode, sort: requestSort, order, filter, q, page, limit }),
  );
}

async function loadVideos({
  mode = 'all',   // mock-only; ignored by the GraphQL branch below
  sort = 'created_at',
  order = 'desc',
  filter = null,
  q = '',
  page = 1,
  limit = 40,
} = {}) {

  // ── Mock branch ──────────────────────────────────────────
  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 400));
    let videos = generateMockVideos(48);

    if (mode !== 'all') {
      videos = videos.filter(v => v.category.toLowerCase() === mode.toLowerCase());
    }

    // `sort` may be `random_<n>`; the comparator knows only `random`.
    videos.sort(mockComparator(baseSort(sort), order, MOCK_SORT_ALIAS));

    return { videos, total: videos.length, page };
  }

  // ── GraphQL branch ───────────────────────────────────────
  const variables = {
    filter: {
      q,
      page,
      per_page: limit,
      sort,                                          // ← straight pass-through
      direction: order === 'asc' ? 'ASC' : 'DESC',
    },
    // Translated at query time, not in filterService: the caller's `filter`
    // stays in the raw stored shape, so the listCache key is unchanged.
    scene_filter: translateFilter(filter, 'SceneFilterType'),
  };

  const data = await runQuery(FIND_SCENES_QUERY, variables);
  const scenes = data?.findScenes?.scenes || [];

  return {
    videos: scenes.map(normalizeScene),
    total: data?.findScenes?.count || 0,
    page,
  };
}

/**
 * Fetch the live state of one scene — used when reopening it to pick up the
 * latest resume_time, since the grid's cached object may be stale.
 *
 * Markers ride along on the same request: the player's progress bar needs them
 * the moment the scene opens, so a second call would be another round trip for
 * data always wanted with the resume point. `Scene.scene_markers` is
 * unpaginated — a handful, not a listing.
 *
 * Sorted here, not trusted from the server: the previous/next-marker buttons
 * binary-search by position, and Stash promises no order. Each carries its
 * primary tag so the "add marker" form can default to this scene's tag without
 * a fourth request.
 */
export async function fetchSceneState(id) {
  if (getSettings().useMock) return null;
  if (!id) return null;
  // Null means "there is nothing to say" — Test mode, or no id. A failed
  // request is not that answer: it means the resume point, the play counts
  // and the markers are *unknown*, and the player must not silently show the
  // scene as never watched. Callers get the error and report it.
  const data = await runQuery(FIND_SCENE_QUERY, { id: String(id) });
  const s = data?.findScene;
  if (!s) return null;
  return {
    id: s.id,
    resume_time: s.resume_time || 0,
    play_count:  s.play_count || 0,
    play_duration: s.play_duration || 0,
    durationSeconds: s.files?.[0]?.duration || 0,
    markers: (s.scene_markers || [])
      .map(m => ({
        id: m.id,
        seconds: m.seconds || 0,
        primaryTag: m.primary_tag
          ? { id: m.primary_tag.id, name: m.primary_tag.name }
          : null,
      }))
      .sort((a, b) => a.seconds - b.seconds),
  };
}

const SCENE_STREAMS_QUERY = `
  query SceneStreams($id: ID!) {
    sceneStreams(id: $id) { url mime_type label }
  }
`;

/**
 * The endpoints Stash will serve this scene from — its own file first, then
 * the configured transcodes.
 *
 * Only asked for when the direct file will not work (see playbackSource.js) or
 * has already failed: it is a second round trip, and 94% of this library is
 * h264/mp4 where the direct stream is better — no server CPU, no transcode
 * startup, and full-range seeking.
 *
 * Returns `[]` rather than throwing: an empty list is a fact the caller acts
 * on, not an error.
 */
export async function fetchSceneStreams(id) {
  if (getSettings().useMock) return [];
  if (!id) return [];
  try {
    const data = await runQuery(SCENE_STREAMS_QUERY, { id: String(id) });
    return data?.sceneStreams || [];
  } catch (e) {
    console.warn('[fetchSceneStreams] failed:', e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// MUTATIONS
// ═══════════════════════════════════════════════════════════

const SCENE_SAVE_ACTIVITY_MUTATION = `
  mutation SceneSaveActivity($id: ID!, $resume_time: Float, $playDuration: Float) {
    sceneSaveActivity(id: $id, resume_time: $resume_time, playDuration: $playDuration)
  }
`;

// `[Timestamp!]`, not `[Time!]`. Both scalars exist in this schema, so the
// wrong one is easy to write: it surfaces only as a validation error naming a
// position — i.e. a console.warn nobody sees on a TV.
const SCENE_ADD_PLAY_MUTATION = `
  mutation SceneAddPlay($id: ID!, $times: [Timestamp!]) {
    sceneAddPlay(id: $id, times: $times) {
      count
    }
  }
`;

const FIND_SCENE_QUERY = `
  query FindScene($id: ID!) {
    findScene(id: $id) {
      id
      resume_time
      play_count
      play_duration
      files { duration }
      scene_markers { id seconds primary_tag { id name } }
    }
  }
`;

/**
 * Save the current playback position, and the watch time accrued since the last
 * save that landed.
 *
 * **`playDuration` is a delta, not a position.** Stash's `SaveActivity` adds it
 * to a running total while *overwriting* `resume_time`. Passing the position
 * would re-add the whole elapsed position on every save: a 40-minute scene
 * saves roughly 80 times over a sitting, so play_duration would reach tens of
 * hours. The caller sends seconds actually watched — see VideoPlayer.
 *
 * Returns `{ok}` rather than throwing: a failed save must never interrupt
 * playback, but must not be invisible either. The caller shows it. No-op in
 * mock mode.
 */
export async function saveSceneActivity({ id, resumeTime, playDuration = 0 }) {
  if (getSettings().useMock) return { ok: true };
  if (!id) return { ok: false };
  try {
    await runQuery(SCENE_SAVE_ACTIVITY_MUTATION, {
      id: String(id),
      resume_time: resumeTime,
      playDuration,
    });
    // Cached pages now hold a stale resume_time, which the card draws as its
    // resume bar. Drop them; the player saves rarely and Map.clear is O(1).
    clearScenePages();
    return { ok: true };
  } catch (e) {
    // Never disturb playback — but say so, because a silent sync failure is
    // the exact bug class this path exists to remove.
    console.warn('[saveSceneActivity] failed:', e.message);
    return { ok: false, error: e };
  }
}

/**
 * Record a play.
 *
 * A play count in Stash is the length of a list of view dates, not a nudged
 * counter, and `sceneAddPlay` is the only supported way to append to it.
 * (`sceneUpdate`'s `play_count`/`o_counter` are deprecated; the resolver logs
 * and drops them.) `sceneAddO`/`sceneDeleteO`/`sceneResetO` are the same shape
 * for the like counter.
 *
 * `times` carries one explicit timestamp rather than `null` (what the
 * deprecated `sceneIncrementPlayCount` passed): "likely one play, now" is not
 * good enough for a write the app cannot undo, and the harness can assert
 * exactly what left the client.
 *
 * Called once per scene per playback session, from the `playing` event — not on
 * mount (which says nothing about watchability) and not per save (which would
 * make the count track the save timer, not the act of watching).
 */
export async function addScenePlay(id, at = new Date()) {
  if (getSettings().useMock) return { ok: true };
  if (!id) return { ok: false };
  try {
    const data = await runQuery(SCENE_ADD_PLAY_MUTATION, {
      id: String(id),
      times: [at.toISOString()],
    });
    return { ok: true, count: data?.sceneAddPlay?.count ?? 0 };
  } catch (e) {
    console.warn('[addScenePlay] failed:', e.message);
    return { ok: false, error: e };
  }
}

