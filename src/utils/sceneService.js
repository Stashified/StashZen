/**
 * sceneService.js — one scene, in full, plus the mutations the detail page
 * offers.
 *
 * Deliberately separate from videoService. That module's `normalizeScene`
 * feeds 40-scene grid pages, and every field it carries is fetched 40× per
 * request — widening it so the detail page could reuse it would put
 * `details`, `urls` and the full `files` array on every card in the grid.
 * Cards want duration and a screenshot; the detail view wants everything.
 * Two normalisers, one query each, is the cheaper trade.
 *
 * Mutations here all invalidate the grid cache on success: the card draws
 * the rating, the organised dot and the like count, so a page fetched before
 * the change is now wrong. See `clearScenePages` in videoService.
 *
 * Every field and mutation below was checked against the live 0.31.1 schema
 * before being written — a wrong field is a 400 at runtime, and this query
 * has no other caller that would have caught it.
 */

import { getSettings } from './settings.js';
import { withApiKey } from './stashUrl.js';
import { runQuery } from './stashQuery.js';
import { clearScenePages, addScenePlay } from './videoService.js';

// `files` is a list, and in practice a scene has exactly one. It is selected
// whole rather than narrowed to the first element because GraphQL has no way
// to say "just the first" — `normalizeSceneDetail` takes files[0] and keeps
// the count, which is the only extra information the array carries.
//
// The element type is `VideoFile`, and its two rate fields are `frame_rate`
// and `bit_rate`. Do not "correct" those to `framerate`/`bitrate`: a type
// named `SceneFileType` does exist on this schema carrying those spellings,
// but `Scene.files` does not resolve to it, and selecting the wrong pair is
// a hard 400 rather than a missing value. Verified by running this exact
// query against the server.
//
// `scene_markers` carries just enough to offer a jump: the timestamp and a
// label. Artwork lives on the Markers tab's own query; selecting screenshot,
// preview or stream here would widen every scene open for something the
// detail page's row never draws.
const FIND_SCENE_DETAIL_QUERY = `
  query FindSceneDetail($id: ID!) {
    findScene(id: $id) {
      id
      title
      code
      details
      date
      rating100
      organized
      o_counter
      play_count
      play_duration
      resume_time
      last_played_at
      urls
      studio { id name }
      tags { id name }
      performers { id name }
      galleries { id title }
      stash_ids { endpoint stash_id }
      scene_markers { id seconds end_seconds title primary_tag { name } }
      files {
        duration
        width
        height
        video_codec
        audio_codec
        frame_rate
        bit_rate
        size
      }
      paths {
        screenshot
        stream
      }
    }
  }
`;

// `sceneUpdate` takes a single `SceneUpdateInput!` carrying the id. Note that
// its `o_counter` field is dead on this server — the resolver logs and drops
// it — which is why liking goes through sceneAddO/sceneDeleteO below.
const SCENE_UPDATE_MUTATION = `
  mutation SceneUpdate($input: SceneUpdateInput!) {
    sceneUpdate(input: $input) {
      id
      rating100
      organized
    }
  }
`;

// These return `HistoryMutationResult { count }` — the scene's o_counter
// after the change, which is authoritative in a way a client-side increment
// is not (two writes racing would otherwise leave the UI showing a number
// the server never held). Verified by probe: add → 1, delete → back to 0.
const SCENE_ADD_O_MUTATION = `
  mutation SceneAddO($id: ID!) {
    sceneAddO(id: $id) { count }
  }
`;

const SCENE_DELETE_O_MUTATION = `
  mutation SceneDeleteO($id: ID!) {
    sceneDeleteO(id: $id) { count }
  }
`;

// The odd one out, and it has to be: `sceneResetO` returns a bare `Int!` while
// its two siblings return `HistoryMutationResult`. Giving it a `{ count }`
// selection — the obvious thing to write, and what a reader of the two above
// would copy — is a *selection-set validation error*, which on a TV is a
// console.warn nobody sees and a button that does nothing. Confirmed against
// the live schema.
const SCENE_RESET_O_MUTATION = `
  mutation SceneResetO($id: ID!) {
    sceneResetO(id: $id)
  }
`;

// `sceneResetActivity` clears *activity*, not history: `reset_resume` zeroes
// `resume_time`, `reset_duration` zeroes `play_duration`, and neither touches
// `last_played_at` or the play count (verified in Stash's store, which writes
// exactly those two columns). Both flags are optional on the schema, so they
// are sent explicitly; Stash's own UI does the same, and an absent flag would
// make the request mean whatever the resolver's default happens to be.
//
// Like `sceneResetO`, this returns a bare scalar (`Boolean!`) rather than an
// object — there is nothing to select.
const SCENE_RESET_ACTIVITY_MUTATION = `
  mutation SceneResetActivity($id: ID!, $reset_resume: Boolean, $reset_duration: Boolean) {
    sceneResetActivity(id: $id, reset_resume: $reset_resume, reset_duration: $reset_duration)
  }
`;

// ── Mock mode ────────────────────────────────────────────────
//
// The grid's mock scenes are generated fresh per request and have ids like
// `vid-7`, so there is nothing on the server to fetch and nothing to write
// to. This echoes the card's own data back with `writable: false`, which
// keeps the page on its real render path instead of branching on Test mode
// — it just can't offer edits it has nowhere to send.
function mockDetail(video) {
  if (!video) return null;
  return {
    ...fromCard(video),
    details: null,
    urls: [],
    studio: video.studio ? { id: null, name: video.studio } : null,
    tags: (video.tags || []).map(name => ({ id: null, name })),
    performers: (video.performers || []).map(name => ({ id: null, name })),
    galleries: [],
    // Two fixed markers keep Test mode (and the README screenshot) on the
    // same render path a live scene uses. Their tags come from the card so
    // they read like this scene's own.
    markers: [120, 600].map((seconds, i) => ({
      id: `mock-marker-${video.id}-${i}`,
      seconds,
      endSeconds: seconds + 30,
      title: video.tags?.[i] || `Marker ${i + 1}`,
      tag: video.tags?.[i] || null,
    })),
    stashIds: [],
    codecs: null,
    sizeBytes: video.filesize ?? null,
    frameRate: video.framerate ?? null,
    bitRate: video.bitrate ?? null,
    // Marked read-only so the page can disable the edit actions rather than
    // offering writes that would silently no-op.
    writable: false,
  };
}

/**
 * The subset of the detail shape that a grid card already carries, so the
 * page can paint instantly on open instead of showing a spinner over data
 * the user is looking at right now. Everything the card cannot know
 * (organized, o_counter, details, codecs) stays undefined until the fetch
 * lands, and the page renders those as placeholders rather than as zero.
 */
export function fromCard(video) {
  if (!video) return null;
  return {
    id: video.id,
    title: video.title || `Scene ${video.id}`,
    screenshot: video.thumbnail || null,
    stream: video.stream || null,
    durationSeconds: video.durationSeconds || 0,
    width: video.width ?? null,
    height: video.height ?? null,
    resumeTime: video.resume_time || 0,
    playCount: video.play_count ?? null,
    // `rating` on a card is a display string ("7.5"); rating100 is the
    // number Stash edits. Reconstructed so the stepper has something to
    // show before the real value arrives — it is replaced, not merged, as
    // soon as the detail query returns.
    rating100: video.rating != null ? Math.round(parseFloat(video.rating) * 10) : null,
    writable: true,
  };
}

export function normalizeSceneDetail(scene) {
  if (!scene) return null;
  const file = scene.files?.[0];

  return {
    id: scene.id,
    title: scene.title || `Scene ${scene.id}`,
    code: scene.code || null,
    details: scene.details || null,
    date: scene.date || null,
    rating100: scene.rating100 ?? 0,
    organized: !!scene.organized,
    oCounter: scene.o_counter || 0,
    playCount: scene.play_count || 0,
    playDurationSeconds: scene.play_duration || 0,
    resumeTime: scene.resume_time || 0,
    lastPlayedAt: scene.last_played_at || null,
    urls: scene.urls || [],
    studio: scene.studio ? { id: scene.studio.id, name: scene.studio.name } : null,
    tags: (scene.tags || []).map(t => ({ id: t.id, name: t.name })),
    performers: (scene.performers || []).map(p => ({ id: p.id, name: p.name })),
    // A scene's galleries are in the same library the Galleries tab browses,
    // so a chip here can hand off to that tab by id (see GalleryChip).
    galleries: (scene.galleries || []).map(g => ({
      id: g.id,
      title: g.title || `Gallery ${g.id}`,
    })),
    // Sorted here rather than trusting the server's order: the row reads as a
    // timeline, and Stash makes no ordering promise on `scene_markers`.
    markers: (scene.scene_markers || [])
      .map(m => ({
        id: m.id,
        seconds: Number.isFinite(m.seconds) ? m.seconds : 0,
        endSeconds: m.end_seconds ?? null,
        title: m.title || m.primary_tag?.name || 'Marker',
        tag: m.primary_tag?.name || null,
      }))
      .sort((a, b) => a.seconds - b.seconds),
    stashIds: (scene.stash_ids || []).map(s => ({ endpoint: s.endpoint, stashId: s.stash_id })),
    fileCount: scene.files?.length || 0,
    // `screenshot` and `stream` are the two paths that actually resolve on
    // this server; preview/sprite/vtt are 404 server-wide
    // (see [[stash-generated-assets-missing]]). Only `stream` comes back
    // keyed, and withApiKey is a no-op on it.
    screenshot: withApiKey(scene.paths?.screenshot) || null,
    stream: withApiKey(scene.paths?.stream) || null,
    durationSeconds: file?.duration || 0,
    width: file?.width ?? null,
    height: file?.height ?? null,
    videoCodec: file?.video_codec || null,
    audioCodec: file?.audio_codec || null,
    frameRate: file?.frame_rate ?? null,
    bitRate: file?.bit_rate ?? null,
    sizeBytes: file?.size ?? null,
    writable: true,
  };
}

/**
 * Full state for one scene, given the card the user opened it from.
 *
 * Takes the card rather than a bare id because Test mode has to answer with
 * something: mock scenes are generated per request with ids like `vid-7`, so
 * there is no server row to read and no id to read it by. The mock branch
 * returns the card's own data with the editable fields flagged read-only,
 * which keeps the page on its real render path instead of special-casing
 * Test mode in the component.
 *
 * Throws on a transport or GraphQL error so the page can show it.
 */
export async function loadSceneDetail(video) {
  if (!video?.id) return null;
  if (getSettings().useMock) return mockDetail(video);
  const data = await runQuery(FIND_SCENE_DETAIL_QUERY, { id: String(video.id) });
  return normalizeSceneDetail(data?.findScene);
}

// ═══════════════════════════════════════════════════════════
// MUTATIONS
// ═══════════════════════════════════════════════════════════

async function sceneUpdate(input) {
  const data = await runQuery(SCENE_UPDATE_MUTATION, { input });
  clearScenePages();
  return data?.sceneUpdate;
}

/**
 * rating100 is Stash's 0–100 rating. 0 means unrated and is written as 0
 * rather than null: the field is a plain Int, and 0 is what Stash's own UI
 * stores when you clear a rating.
 */
export async function updateSceneRating(id, rating100) {
  const clamped = Math.max(0, Math.min(100, Math.round(rating100)));
  const result = await sceneUpdate({ id: String(id), rating100: clamped });
  return result?.rating100 ?? clamped;
}

export async function setSceneOrganized(id, organized) {
  const result = await sceneUpdate({ id: String(id), organized: !!organized });
  return result?.organized ?? !!organized;
}

/**
 * Liking is an atomic increment on the server, not a set-to-value — Stash
 * also records an `o_history` entry, which is what its own UI reads back.
 * Returns the server's resulting counter.
 */
export async function addSceneO(id) {
  const data = await runQuery(SCENE_ADD_O_MUTATION, { id: String(id) });
  clearScenePages();
  return data?.sceneAddO?.count;
}

/**
 * Un-like. `sceneDeleteO` removes the most recent history entry, so this
 * undoes one like rather than clearing all of them — the counter matches
 * however many likes actually happened.
 *
 * No longer reachable from the scene page, which increments on every press and
 * clears on a hold (see SceneDetailPage). Kept because "undo one" is the only
 * correct inverse of an increment, and the pair is the reason a bare
 * `sceneUpdate({o_counter})` is not the tool for either job.
 */
export async function deleteSceneO(id) {
  const data = await runQuery(SCENE_DELETE_O_MUTATION, { id: String(id) });
  clearScenePages();
  return data?.sceneDeleteO?.count;
}

/**
 * Clear the counter outright, history included.
 *
 * Reached by holding OK rather than by a press: it is destructive in a way the
 * increment is not — `sceneDeleteO` would have to be pressed once per like to
 * get here — and a hold is the gesture the remote already has for "the thing
 * behind the thing". Returns the resulting counter, which is 0 unless someone
 * else wrote in between.
 */
export async function resetSceneO(id) {
  const data = await runQuery(SCENE_RESET_O_MUTATION, { id: String(id) });
  clearScenePages();
  return data?.sceneResetO;
}

/**
 * Clear the resume point, so the scene leaves Continue Watching.
 *
 * `reset_duration` is deliberately false. Stash resets the two independently
 * — its own history panel has "reset resume time" and "reset play duration"
 * as separate actions — and watch time is history that this action has no
 * reason to destroy. The scene still counts as watched; it just no longer has
 * a place to resume from.
 *
 * Returns whether the server applied it. A refused reset is a real response
 * (`Boolean!`), not an error, and the page has to roll back either way.
 */
export async function resetSceneProgress(id) {
  const data = await runQuery(SCENE_RESET_ACTIVITY_MUTATION, {
    id: String(id), reset_resume: true, reset_duration: false,
  });
  if (!data?.sceneResetActivity) return false;
  clearScenePages();
  return true;
}

/**
 * Mark a scene played now, without watching it.
 *
 * The write is `sceneAddPlay` — the same mutation the player fires on its
 * first `playing` event — so "a play" has one definition in this app: one
 * explicit timestamp appended to Stash's view list. The deprecated
 * `sceneIncrementPlayCount` is the sibling the survey named, and it is not on
 * the 0.31.1 schema at all; `sceneAddPlay` is what replaced it. (See
 * `addScenePlay` in videoService for the full rationale.)
 *
 * The scene's `last_played_at` moves, which is the sort key of Continue
 * Watching, so the grid cache is dropped like every other write here.
 */
export async function markScenePlayed(id) {
  const res = await addScenePlay(id);
  if (res.ok) clearScenePages();
  return res;
}
