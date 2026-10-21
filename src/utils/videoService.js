/**
 * videoService.js — Fetch scenes from a Stash GraphQL endpoint
 *
 * URL, API key, and Test/Live mode are read at request time from
 * the settings store (see ../utils/settings.js) so the user can
 * configure them at runtime via the Settings panel.
 *
 * Sort keys are passed through directly to Stash — UI keys MUST match
 * Stash's GraphQL sort enum values (created_at, title, rating, etc).
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

// The two scene sort values whose mock field has another name. `duration` is
// the formatter's output on a card, not a number — the seconds live in
// `durationSeconds`; `resolution` is a named server enum, and the nearest
// honest ordering a mock can offer is its pixel height.
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
// Everything below is invented, and none of it is random per call: the
// numbers come from a PRNG seeded on the scene's id, so a scene keeps its
// duration, rating and cover for as long as the app is pointed at Test mode.
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
      // Some scenes are unrated and some have never been watched, because a
      // card has to render both of those states and Test mode is where the
      // difference gets looked at.
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
 * `date` is a date-only value ("2019-05-04"), which `new Date()` parses as UTC
 * midnight — so `getFullYear()` in any negative-offset timezone answers the
 * year *before*, and a 2019 scene card read 2018 for everyone west of
 * Greenwich. The year is the first four characters; there is nothing to
 * compute.
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
    // Every one of these except `stream` arrives from Stash without the API
    // key; `stream` already has it. withApiKey is a no-op on the latter.
    //
    // `preview` is carried again as of 0.6.0. It was dropped when the focus
    // preview was, with the note "nothing renders it" — true at the time and
    // no longer. What made that note sound was that `paths.preview` is a
    // non-empty URL for *every* scene even when no preview file exists, so a
    // card that trusted it always took the preview branch and sat on a black
    // tile. The URL is still advertised unconditionally; the difference is
    // that VideoCard now treats the <video> element as its own probe and
    // keeps the cover until that element reports a frame. See its header.
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
    // Carried for the *player*, not for any card: a file the TV's <video>
    // cannot decode is playing-edition information, and the card has no use
    // for it. See playbackSource.js for what is done with them, and why
    // "unknown" is a different answer from "known bad".
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
 * Cached page fetch. Switching tabs, or coming back to a sort you already
 * looked at, renders from here instead of re-showing the spinner — the
 * request itself is only ~28 ms (see [[stash-image-serving-facts]]), so the
 * win is the perceived one, not the wall-clock one.
 *
 * The key carries the full request identity, and listCacheKey folds in the
 * data source, so Test and Live can't be served each other's pages.
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
  // `random` re-shuffles on every request server-side, so page 2 would overlap
  // page 1 and the no-progress stop could end a short list early (the review's
  // R8). Seed it from the listing's identity — never the page number — so one
  // listing is one permutation across every page. See randomSort.js.
  const requestSort = stableSort(sort, 'scenes', mode, filter, q);
  return sceneCache.get(
    listCacheKey('scenes', mode, requestSort, order, filter, q, page, limit),
    () => loadVideos({ mode, sort: requestSort, order, filter, q, page, limit }),
  );
}

// (this was `fetchVideos` before the list cache was added; the cache wrapper
// above is the only caller)
async function loadVideos({
  mode = 'all',
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
    // Translated here, at query time, rather than in filterService: the caller's
    // `filter` stays in the raw stored shape, so the listCache key it was built
    // from is unchanged and cached pages survive this fix.
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
 * Fetch the live state of a single scene — used when reopening a
 * scene to pick up the latest resume_time, since the grid's cached
 * scene object may be stale (the position was saved to Stash but
 * the grid wasn't refetched).
 *
 * The scene's markers ride along on the same request. They are needed the
 * moment the scene opens (the player's progress bar draws one tick per
 * marker) and per-scene, so a second request would be a second round trip
 * on every open for data the player always wants at the same time as the
 * resume point. `Scene.scene_markers` is unpaginated — a scene's markers
 * are a handful, not a listing.
 *
 * Sorted here rather than trusted from the server: the player's "previous /
 * next marker" buttons binary-search by position, and Stash does not
 * promise an order.
 *
 * Each marker carries its primary tag so the "add marker" form can default to
 * the tag this scene is already tagged with. Deriving it from markers the
 * player has already fetched avoids a fourth request (`sceneMarkerTags`)
 * purely to guess a default.
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
 * whatever transcodes the server is configured to offer.
 *
 * Only asked for when the direct file is not going to work (see
 * playbackSource.js) or when it has already failed, never on the ordinary
 * play path: it is a second round trip, and 94% of this library is h264/mp4
 * where the direct stream is not merely adequate but better — no server CPU,
 * no transcode startup, and full-range seeking rather than a growing file.
 *
 * Returns `[]` rather than throwing. A server with transcoding switched off
 * answers with an empty list, and "no transcodes available" is a fact the
 * caller acts on, not an error.
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

// fetchRandomVideos() lived here until 0.7.6. It fed RandomPage, which the
// 0.7.0 left-rail rework deleted, and it went on sitting here unreferenced for
// five releases — the last caller of `Math.random()` in the Test-mode path,
// and so the one place in the app that still contradicted the "a seed is
// always the same picture" guarantee mockArt.js and mockLibrary.js are built
// on. The "Random" left in the UI is a *sort key* — one option in App.jsx's
// SCENE_SORT_GROUPS, served by fetchVideos above — a different thing that
// never used this. Nothing to bring back: if a Random surface returns, it
// should be a sort on the existing paged fetch, not a second unpaged one.

// ═══════════════════════════════════════════════════════════
// MUTATIONS
// ═══════════════════════════════════════════════════════════

const SCENE_SAVE_ACTIVITY_MUTATION = `
  mutation SceneSaveActivity($id: ID!, $resume_time: Float, $playDuration: Float) {
    sceneSaveActivity(id: $id, resume_time: $resume_time, playDuration: $playDuration)
  }
`;

// `[Timestamp!]`, not `[Time!]`. Both scalars exist in this Stash's schema, which
// is what makes the wrong one easy to write and hard to notice: the request
// validates as *declared*, so the mismatch only shows up as a validation error
// naming the position, and on a TV that error is a console.warn nobody sees.
// Confirmed against the live schema.
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
 * Save the current playback position, and the watch time that has accrued since
 * the last save that landed.
 *
 * **`playDuration` is a delta, not a position.** Stash's `SaveActivity` adds it
 * to a running total (`play_duration = play_duration + ?`) while it *overwrites*
 * `resume_time`. Passing the position would re-add the whole elapsed position on
 * every save: a 40-minute scene saves roughly 80 times over a sitting, so the
 * library's play_duration would end up in the tens of hours for it. The caller
 * is responsible for sending seconds actually watched — see VideoPlayer.
 *
 * Resume position is the half that was already working, verified on the TV: the
 * card's resume bar appears after a partial watch, which means this write lands,
 * the page cache is dropped, and the grid refetches.
 *
 * Returns `{ok}` rather than throwing, because a failed save must never
 * interrupt playback — but it must not be invisible either. The caller shows it.
 * No-op in mock mode.
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
    // The cached pages now hold a stale resume_time for this scene, and the
    // grid draws that as the resume bar on the card. Drop them so returning
    // to the grid refetches rather than showing where you *were*. Cheap: the
    // player only saves every RESUME_SAVE_INTERVAL_MS, and Map.clear is O(1).
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
 * In Stash a play count is not a counter that gets nudged — it is the length of
 * a list of view dates, and `sceneAddPlay` is the only supported way to append
 * to it. (`sceneUpdate`'s `play_count` and `o_counter` fields are deprecated and
 * the resolver logs them and drops them.) The sibling mutations `sceneAddO` /
 * `sceneDeleteO` / `sceneResetO` are the same shape for the like counter.
 *
 * `times` carries one explicit timestamp rather than `null`. `null` is what the
 * deprecated `sceneIncrementPlayCount` passed, and it most likely means "one
 * play, now" — but *likely* is not good enough for a write the app cannot undo:
 * one explicit time is one row under either reading, and the harness can assert
 * exactly what left the client.
 *
 * Called once per scene per playback session, from the `playing` event. Not on
 * mount, because mounting says nothing about whether the file was watchable, and
 * not per save, because that would make the count track the save timer rather
 * than the act of watching.
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

