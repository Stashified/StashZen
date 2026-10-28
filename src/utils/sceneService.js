/**
 * sceneService.js: one scene, in full, plus the mutations the detail page
 * offers.
 *
 * Separate from videoService on purpose: its `normalizeScene` feeds 40-scene
 * grid pages, so every field is fetched 40× per request, widening it for the
 * detail page would put `details`, `urls` and the full `files` array on every
 * card. Cards want duration and a screenshot; the detail view wants everything.
 *
 * Mutations invalidate the grid cache on success: the card draws the rating,
 * organised dot and like count, so an earlier page is now wrong. See
 * `clearScenePages`.
 *
 * Every field and mutation was checked against the live schema: a wrong field
 * is a runtime 400, and no other caller would catch it.
 */

import { getSettings } from './settings.js';
import { withApiKey } from './stashUrl.js';
import { runQuery } from './stashQuery.js';
import { clearScenePages, addScenePlay } from './videoService.js';
import { publishRowPatch } from './rowPatches.js';

// `files` is a list and in practice holds one; GraphQL cannot select just the
// first, so `normalizeSceneDetail` takes files[0] and keeps the count.
//
// The element type is `VideoFile`, whose rate fields are `frame_rate` and
// `bit_rate`. Do not "correct" these to `framerate`/`bitrate`: `SceneFileType`
// exists on this schema with those spellings, but `Scene.files` does not
// resolve to it, and the wrong pair is a hard 400.
//
// `scene_markers` carries just enough to offer a jump: timestamp and label.
// Artwork lives on the Markers tab's query; selecting it here would widen every
// scene open for something the detail row never draws.
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

// `sceneUpdate` takes a single `SceneUpdateInput!` carrying the id. Its
// `o_counter` field is dead on this server (the resolver logs and drops it), so
// liking goes through sceneAddO/sceneDeleteO below.
const SCENE_UPDATE_MUTATION = `
  mutation SceneUpdate($input: SceneUpdateInput!) {
    sceneUpdate(input: $input) {
      id
      rating100
      organized
    }
  }
`;

// These return `HistoryMutationResult { count }`, the o_counter after the
// change, authoritative in a way a client-side increment is not (racing writes
// would leave the UI showing a number the server never held).
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

// The odd one out: `sceneResetO` returns a bare `Int!` while its siblings
// return `HistoryMutationResult`. Giving it a `{ count }` selection is a
// *selection-set validation error*, on a TV, a console.warn nobody sees and a
// button that does nothing.
const SCENE_RESET_O_MUTATION = `
  mutation SceneResetO($id: ID!) {
    sceneResetO(id: $id)
  }
`;

// `sceneResetActivity` clears *activity*, not history: `reset_resume` zeroes
// `resume_time` and `reset_duration` zeroes `play_duration`; neither touches
// `last_played_at` or the play count. Both flags are optional on the schema, so
// they are sent explicitly, an absent flag would mean the resolver's default.
//
// It returns a bare `Boolean!`, so there is nothing to select.
const SCENE_RESET_ACTIVITY_MUTATION = `
  mutation SceneResetActivity($id: ID!, $reset_resume: Boolean, $reset_duration: Boolean) {
    sceneResetActivity(id: $id, reset_resume: $reset_resume, reset_duration: $reset_duration)
  }
`;

// ── Mock mode ────────────────────────────────────────────────
//
// Mock scenes are generated per request with ids like `vid-7`, so there is
// nothing on the server to fetch or write. Echo the card's data with
// `writable: false`: the page stays on its real render path instead of
// branching on Test mode, and simply offers no edits.
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
    // Two fixed markers keep Test mode (and the README screenshot) on the same
    // render path a live scene uses; tags come from the card.
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
    // Read-only, so the page disables edits rather than offering silent no-ops.
    writable: false,
  };
}

/**
 * The subset of the detail shape a grid card already carries, so the page paints
 * instantly instead of showing a spinner over data the user is looking at.
 * Everything the card cannot know (organized, o_counter, details, codecs) stays
 * undefined until the fetch lands; the page renders placeholders, not zeros.
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
    // `rating` on a card is a display string ("7.5"); rating100 is what Stash
    // edits. Reconstructed for the stepper, then replaced (not merged) when the
    // detail query returns.
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
    // `screenshot` and `stream` are the two paths that resolve on this server;
    // preview/sprite/vtt are 404 server-wide. Only `stream` comes back keyed,
    // and withApiKey is a no-op on it.
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
 * Takes the card rather than an id because Test mode must answer with
 * something, mock scenes have no server row. The mock branch returns the
 * card's data read-only, keeping the page on its real render path.
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
 * rating100 is Stash's 1–100 rating; unrated is **null**. Stash's own UI sends
 * null on clear, and 0 is a real value its filters and sorts count as rated.
 */
export async function updateSceneRating(id, rating100) {
  // The clamp lets NaN through; GraphQL's Int cannot hold it.
  if (!Number.isFinite(Number(rating100))) {
    throw new RangeError('rating100 must be a finite number');
  }
  const clamped = Math.max(0, Math.min(100, Math.round(rating100)));
  const next = clamped > 0 ? clamped : null;
  const result = await sceneUpdate({ id: String(id), rating100: next });
  // A zero the server echoes back is still "unrated" to this app.
  const saved = result
    ? (Number.isFinite(result.rating100) && result.rating100 > 0 ? result.rating100 : null)
    : next;
  // The card draws the display string normalizeVideo builds.
  publishRowPatch('scene', id, {
    rating: saved != null ? (saved / 10).toFixed(1) : null,
  });
  return saved;
}

export async function setSceneOrganized(id, organized) {
  const result = await sceneUpdate({ id: String(id), organized: !!organized });
  return result?.organized ?? !!organized;
}

/**
 * Liking is an atomic server increment, not a set-to-value; Stash also records
 * an `o_history` entry, which its own UI reads back. Returns the counter.
 */
export async function addSceneO(id) {
  const data = await runQuery(SCENE_ADD_O_MUTATION, { id: String(id) });
  clearScenePages();
  return data?.sceneAddO?.count;
}

/**
 * Un-like. `sceneDeleteO` removes the most recent history entry, undoing one
 * like rather than clearing all, the counter matches the likes that happened.
 *
 * Kept even though the scene page now increments on press and clears on hold:
 * "undo one" is the only correct inverse of an increment, and the pair is why a
 * bare `sceneUpdate({o_counter})` is not the tool for either job.
 */
export async function deleteSceneO(id) {
  const data = await runQuery(SCENE_DELETE_O_MUTATION, { id: String(id) });
  clearScenePages();
  return data?.sceneDeleteO?.count;
}

/**
 * Clear the counter outright, history included.
 *
 * Reached by holding OK, not a press: it is destructive in a way the increment
 * is not (`sceneDeleteO` would need one press per like), and a hold is the
 * remote's existing gesture for "the thing behind the thing". Returns 0 unless
 * someone else wrote in between.
 */
export async function resetSceneO(id) {
  const data = await runQuery(SCENE_RESET_O_MUTATION, { id: String(id) });
  clearScenePages();
  return data?.sceneResetO;
}

/**
 * Clear the resume point, so the scene leaves Continue Watching.
 *
 * `reset_duration` is deliberately false: Stash resets the two independently,
 * and watch time is history this action has no reason to destroy. The scene
 * still counts as watched, just without a place to resume from.
 *
 * Returns whether the server applied it: a refused reset is a real `Boolean!`
 * response, not an error, and the page has to roll back either way.
 */
export async function resetSceneProgress(id) {
  const data = await runQuery(SCENE_RESET_ACTIVITY_MUTATION, {
    id: String(id), reset_resume: true, reset_duration: false,
  });
  if (!data?.sceneResetActivity) return false;
  clearScenePages();
  publishRowPatch('scene', id, { resume_time: 0 });
  return true;
}

/**
 * Mark a scene played now, without watching it.
 *
 * Uses `sceneAddPlay`, the same mutation the player fires on its first
 * `playing` event, so "a play" has one definition: one explicit timestamp
 * appended to Stash's view list. (`sceneIncrementPlayCount` is deprecated and
 * not on the current schema; see `addScenePlay` in videoService.)
 *
 * `last_played_at` moves, the Continue Watching sort key, so the grid cache
 * is dropped like every other write here.
 */
export async function markScenePlayed(id) {
  const res = await addScenePlay(id);
  if (res.ok) clearScenePages();
  return res;
}
