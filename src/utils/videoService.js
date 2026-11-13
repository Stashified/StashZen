/**
 * videoService.js: fetch scenes from a Stash GraphQL endpoint.
 *
 * URL, API key and Test/Live mode are read at request time from the settings
 * store so the user can configure them at runtime.
 *
 * Sort keys pass straight through to Stash, UI keys MUST match Stash's GraphQL
 * sort enum values (created_at, title, rating, etc).
 */

import { getSettings } from './settings.js';
import { withApiKey } from './stashUrl.js';
import { runQuery, withoutCount } from './stashQuery.js';
import { createListCache, listCacheKey } from './listCache.js';
import { publishRowPatch } from './rowPatches.js';
import { translateFilter } from './filterTranslate.js';
import { mockComparator } from './mockSort.js';
import { stableSort } from './randomSort.js';
import { ratingLabel } from './format.js';

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
// MOCK DATA (Test mode, see mockLibrary.js and mockArt.js)
// ═══════════════════════════════════════════════════════════
// Everything below is invented but stable: a PRNG seeded on the scene's id, so
// a scene keeps its duration, rating and cover while the app is in Test mode.
// That is what makes a layout change comparable before and after.
//
// Loaded on demand: Test mode is the only caller, and the catalogue plus the
// art generator are ~26 KB of code a Live TV would otherwise parse at startup.
async function generateMockVideos(count = 48) {
  const { SCENE_TITLES, STUDIOS, MOCK_HEIGHTS, MOCK_DETAILS, mockScenePerformers } =
    await import('./mockLibrary.js');
  const { coverArt, makeRng } = await import('./mockArt.js');
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const rng = makeRng(`scene-${i}`);
    const seconds = Math.round(180 + rng() * 5400);        // 3 min to ~1h33
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    const plays = Math.floor(rng() * 14);
    const height = MOCK_HEIGHTS[Math.floor(rng() * MOCK_HEIGHTS.length)];
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
      // Derived from `i`, not the RNG: adding a draw here would shift every
      // fixture value below it.
      organized: i % 3 === 1,
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
      // The 0.32 sort needs a value on every row; from `i` so the RNG stream
      // above keeps every pinned fixture value where it was.
      production_date: `${1962 + ((i * 7) % 60)}-01-01`,
      category: STUDIOS[i % STUDIOS.length],
      // What the player's overlay names. Derived from `i`, not the RNG, so
      // every pinned fixture value above stays put.
      studio: STUDIOS[i % STUDIOS.length],
      performers: mockScenePerformers(i % SCENE_TITLES.length),
      // The carousel hero's blurb, so Test mode draws the two-line slot. From
      // `i`, not the RNG, for the same reason as the fields above.
      details: MOCK_DETAILS[i % MOCK_DETAILS.length],
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
// What a card draws, and what the player needs from the row. Shared with the
// related-rows query below so a field added for one cannot go missing in the
// other.
const SCENE_ROW_FIELDS = `
  fragment SceneRowFields on Scene {
    id
    title
    date
    rating100
    play_count
    o_counter
    organized
    files {
      duration
      width
      height
      frame_rate
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
    # The player's overlay names the cast. Cards do not draw it, but the row is
    # the player's only input, and a scene has a handful of performers.
    performers {
      id
      name
    }
    tags {
      id
      name
    }
  }
`;

// Scene details are a paragraph and only the carousel hero draws them, so the
// heavier query is a separate fragment: grids do not pay for the text.
const SCENE_HERO_FIELDS = `
  fragment SceneHeroFields on Scene {
    ...SceneRowFields
    details
  }
`;

const FIND_SCENES_QUERY = `
  query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
    findScenes(filter: $filter, scene_filter: $scene_filter) {
      count
      scenes { ...SceneRowFields }
    }
  }
  ${SCENE_ROW_FIELDS}
`;

// Pages after the first do not read the total, see withoutCount.
const FIND_SCENES_PAGE_QUERY = withoutCount(FIND_SCENES_QUERY);

const FIND_SCENES_HERO_QUERY = `
  query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
    findScenes(filter: $filter, scene_filter: $scene_filter) {
      count
      scenes { ...SceneHeroFields }
    }
  }
  ${SCENE_ROW_FIELDS}
  ${SCENE_HERO_FIELDS}
`;

const FIND_SCENES_HERO_PAGE_QUERY = withoutCount(FIND_SCENES_HERO_QUERY);

// Two axes: does the caller want scene details, and is this the first page
// (the only one that reads the total).
const SCENE_QUERIES = {
  base: { first: FIND_SCENES_QUERY, next: FIND_SCENES_PAGE_QUERY },
  hero: { first: FIND_SCENES_HERO_QUERY, next: FIND_SCENES_HERO_PAGE_QUERY },
};

function formatDuration(seconds) {
  if (!seconds) return '–';
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

export function normalizeScene(scene) {
  const file = scene.files?.[0];
  const duration = file?.duration || 0;
  const year = yearOf(scene.date);

  return {
    id: scene.id,
    title: scene.title || `Scene ${scene.id}`,
    // Only the hero query selects it; the carousel draws it as the blurb.
    details: scene.details || null,
    duration: formatDuration(duration),
    durationSeconds: duration,
    year,
    rating: ratingLabel(scene.rating100),
    category: scene.studio?.name || scene.tags?.[0]?.name || 'Untagged',
    // `screenshot`/`sprite`/`vtt`/`preview` arrive unkeyed. `stream` arrives
    // keyed (0.31) or signed (0.32 with credentials); the appended key covers
    // both, and outlives a signature.
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
    o_counter: scene.o_counter || 0,
    organized: !!scene.organized,
    studio: scene.studio?.name,
    performers: (scene.performers || []).map(p => p.name),
    tags: scene.tags?.map(t => t.name) || [],
    width: file?.width,
    height: file?.height,
    // VideoCard skips the focus preview above ~90 fps: previews generated from
    // such sources blank the whole TV screen on Tizen. See its `canTry`.
    frameRate: file?.frame_rate ?? null,
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
 *, a resume position, a rating, a like, has to call this, or the grid keeps
 * serving the page it fetched before the change.
 */
export function clearScenePages() {
  sceneCache.clear();
  relatedCache.clear();
}

/**
 * Cached page fetch. Switching tabs or returning to a sort already seen renders
 * from here instead of re-showing the spinner, the request is only ~28 ms, so
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
  hero = false,
  signal,
} = {}) {
  // `random` re-shuffles server-side on every request, so page 2 would overlap
  // page 1 and the no-progress stop could end a short list early. Seed from the
  // listing's identity, never the page number. See randomSort.js.
  const requestSort = stableSort(sort, 'scenes', mode, filter, q);
  return sceneCache.get(
    // A hero page carries details a grid page does not, so they cannot share
    // a cache entry.
    listCacheKey('scenes', mode, requestSort, order, filter, q, page, limit,
      hero ? 'hero' : 'base'),
    () => loadVideos({ mode, sort: requestSort, order, filter, q, page, limit, hero, signal }),
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
  hero = false,
  signal,
} = {}) {

  // ── Mock branch ──────────────────────────────────────────
  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 400));
    let videos = await generateMockVideos(48);

    if (mode !== 'all') {
      videos = videos.filter(v => v.category.toLowerCase() === mode.toLowerCase());
    }

    const needle = (q || '').trim().toLowerCase();
    if (needle) {
      videos = videos.filter(v => String(v.title || '').toLowerCase().includes(needle));
    }

    // `sort` may be `random_<n>`; the comparator ranks that seed too.
    videos.sort(mockComparator(sort, order, MOCK_SORT_ALIAS));

    // Slice like the marker and entity mocks do. Returning the whole library
    // for every page defeated paging and ignored the search sections' limit.
    const start = (page - 1) * limit;
    return { videos: videos.slice(start, start + limit), total: videos.length, page };
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

  const { first, next } = SCENE_QUERIES[hero ? 'hero' : 'base'];
  const query = page > 1 ? next : first;
  const data = await runQuery(query, variables, { signal });
  const scenes = data?.findScenes?.scenes || [];

  return {
    videos: scenes.map(normalizeScene),
    total: data?.findScenes?.count || 0,
    page,
  };
}

// The detail page's two "More from" rows, in one request: both are findScenes
// listings fired at the same instant. The document is built per open because a
// scene may carry only one of the two entities, and asking an absent one for
// rows would be a whole listing read for nothing.
const relatedCache = createListCache();

/**
 * @returns {Promise<{byStudio?: Array, byPerformer?: Array}>} the requested
 *   rows, normalised; a key is absent when its filter was not passed.
 */
export async function fetchRelatedScenes({
  studioFilter = null, performerFilter = null, limit = 5, signal,
} = {}) {
  const wanted = [];
  if (studioFilter) wanted.push(['byStudio', studioFilter]);
  if (performerFilter) wanted.push(['byPerformer', performerFilter]);
  if (!wanted.length) return {};

  const key = listCacheKey('related', limit, wanted);
  // Set by the loader when one root of the document failed.
  let partial = false;
  // Requested above the mock branch: Test mode's generators are deterministic,
  // so its rows deserve the same reopen-is-free behaviour.
  const out = await relatedCache.get(key, async () => {
    if (getSettings().useMock) {
      const entries = await Promise.all(wanted.map(async ([alias, filter]) => {
        const { videos } = await fetchVideos({
          filter, limit, sort: 'created_at', order: 'desc', signal,
        });
        return [alias, videos];
      }));
      return Object.fromEntries(entries);
    }

    const decls = wanted
      .map((_, i) => `$f${i}: FindFilterType, $sf${i}: SceneFilterType`)
      .join(', ');
    const roots = wanted
      .map(([alias], i) =>
        `${alias}: findScenes(filter: $f${i}, scene_filter: $sf${i}) { scenes { ...SceneRowFields } }`)
      .join('\n');
    const variables = {};
    wanted.forEach(([, filter], i) => {
      variables[`f${i}`] = {
        page: 1, per_page: limit, sort: 'created_at', direction: 'DESC',
      };
      variables[`sf${i}`] = translateFilter(filter, 'SceneFilterType');
    });

    // GraphQL can fail one aliased root and answer the other; the error
    // carries that partial data (see graphqlRequest), so a studio's bad filter
    // does not empty the performer row too.
    let data;
    try {
      data = await runQuery(
        `query FindRelatedScenes(${decls}) { ${roots} }
        ${SCENE_ROW_FIELDS}`,
        variables,
        { signal },
      );
    } catch (e) {
      const answered = e?.data;
      if (!answered || !wanted.some(([alias]) => answered[alias] != null)) throw e;
      data = answered;
      partial = true;
    }
    return Object.fromEntries(wanted.map(([alias]) =>
      [alias, (data?.[alias]?.scenes || []).map(normalizeScene)]));
  });

  // A lost root is not an answer worth serving for the whole session; a reopen
  // is how the row gets another chance.
  if (partial) relatedCache.forget(key);
  return out;
}

/**
 * One random scene, honouring a filter and a search term. For Surprise.
 *
 * Deliberately outside the page cache and `stableSort`: `fetchVideos` pins a
 * listing's `random` to one seed so its pages cannot overlap, and the cache
 * would then hand back the same scene on every press. One row, one request.
 */
export async function fetchRandomVideo({ filter = null, q = '', signal } = {}) {
  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 250));
    let videos = await generateMockVideos(48);
    const needle = (q || '').trim().toLowerCase();
    if (needle) {
      videos = videos.filter(v => String(v.title || '').toLowerCase().includes(needle));
    }
    return videos.length ? videos[Math.floor(Math.random() * videos.length)] : null;
  }

  const variables = {
    filter: { q, page: 1, per_page: 1, sort: 'random' },
    scene_filter: translateFilter(filter, 'SceneFilterType'),
  };
  // One row, no total read: the count would be a second full scan.
  const data = await runQuery(FIND_SCENES_PAGE_QUERY, variables, { signal });
  const scene = data?.findScenes?.scenes?.[0];
  return scene ? normalizeScene(scene) : null;
}

/**
 * Fetch the live state of one scene, used when reopening it to pick up the
 * latest resume_time, since the grid's cached object may be stale.
 *
 * Markers ride along on the same request: the player's progress bar needs them
 * the moment the scene opens, so a second call would be another round trip for
 * data always wanted with the resume point. `Scene.scene_markers` is
 * unpaginated, a handful, not a listing.
 *
 * Sorted here, not trusted from the server: the previous/next-marker buttons
 * binary-search by position, and Stash promises no order. Each carries its
 * primary tag so the "add marker" form can default to this scene's tag without
 * a fourth request.
 */
export async function fetchSceneState(id) {
  if (getSettings().useMock) return null;
  if (!id) return null;
  // Null means "there is nothing to say", Test mode, or no id. A failed
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
 * The endpoints Stash will serve this scene from, its own file first, then
 * the configured transcodes.
 *
 * Only asked for when the direct file will not work (see playbackSource.js) or
 * has already failed: it is a second round trip, and 94% of this library is
 * h264/mp4 where the direct stream is better, no server CPU, no transcode
 * startup, and full-range seeking.
 *
 * Returns `[]` when Stash answered "no transcodes"; that is a fact. A failed
 * request returns `null`, because "could not ask" must not be cached as the
 * same fact or a transient timeout would disable transcoding for the plan.
 *
 * Endpoints are keyed here, not by the caller: Stash 0.32 signs them when
 * credentials are configured, and it forwards `apikey` to HLS segments in
 * preference to the expiring signature.
 */
export async function fetchSceneStreams(id) {
  if (getSettings().useMock) return [];
  if (!id) return [];
  try {
    const data = await runQuery(SCENE_STREAMS_QUERY, { id: String(id) });
    return (data?.sceneStreams || []).map((e) => ({
      ...e,
      url: withApiKey(e.url),
    }));
  } catch (e) {
    console.warn('[fetchSceneStreams] failed:', e.message);
    return null;
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
// position, i.e. a console.warn nobody sees on a TV.
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
 * hours. The caller sends seconds actually watched, see VideoPlayer.
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
    // Mounted lists are patched in place, which is what the card's resume bar
    // reads; unmounted pages are dropped on the next tab switch
    // (clearAllListCaches). Clearing every scene page here refetched the whole
    // listing on the next visit for a value the patch already carries.
    publishRowPatch('scene', id, { resume_time: resumeTime ?? 0 });
    return { ok: true };
  } catch (e) {
    // Never disturb playback, but say so, because a silent sync failure is
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
 * Called once per scene per playback session, from the `playing` event, not on
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
    const count = data?.sceneAddPlay?.count ?? 0;
    // The card reads play_count: patch it, drop cached pages.
    clearScenePages();
    publishRowPatch('scene', id, { play_count: count });
    return { ok: true, count };
  } catch (e) {
    console.warn('[addScenePlay] failed:', e.message);
    return { ok: false, error: e };
  }
}

