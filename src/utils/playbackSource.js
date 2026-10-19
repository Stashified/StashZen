/**
 * playbackSource — what the player should hand the <video>, and when a scene
 * has to go through Stash's transcoder instead of its own file.
 *
 * Why this exists. Stash serves the file it has: `paths.stream` is that file,
 * container and codecs included. A TV's own media pipeline decodes far more
 * than a `<video>` element does, and this app plays through a `<video>`, so
 * "it plays in Stash's web UI" and "it plays in VLC" say nothing about here.
 * Measured against this library (5,836 scenes, counted from the API on
 * 2026-10-16):
 *
 *     video      h264 4292 · av1 837 · hevc 265 · wmv2 223 · mpeg4 99
 *                wmv3 94 · mpeg1video 29 · mjpeg 9 · indeo5 1 · msmpeg4v3 1
 *     audio      aac 5472 · wmav2 317 · mp1 16 · mp3 13 · ac3 6 · dts 3 …
 *     container  mp4 5341 · wmv 317 · matroska 138 · mpeg 29 · avi 24 · flv 1
 *
 * Reported as "a file with codec msmpeg4v3 doesn't want to play" — it is not
 * one file. MS-MPEG4 v2/v3, WMV (v2 is a RealVideo-derived SP, v3 is VC-1),
 * MPEG-4 Part 2 / Xvid, MPEG-1 and MJPEG are all outside what any Chromium
 * engine decodes, and `wmv`, `avi`, `mpeg` (program stream) and `flv` are
 * containers it will not demux either. Stash can re-encode any of them on
 * demand, and `sceneStreams(id)` is where it advertises the results.
 *
 * Two halves, and they are deliberately different kinds of guess:
 *
 *  1. `needsTranscode` is *pre-emptive* and only fires on a codec we are
 *     **sure** is unplayable. An absent field means "no opinion" and leaves
 *     the direct stream alone — the net below catches those, and a wrong
 *     pre-emptive answer costs a transcode the server has to run.
 *  2. The player's error and stall fallback (see usePlaybackSource) is
 *     *reactive* and covers everything this list gets wrong, in either
 *     direction: a scene we sent direct that fails falls back to a transcode,
 *     and one we sent to the transcoder that fails falls back to direct.
 *
 * That second half is what makes the first half safe to get wrong, which
 * matters more than the list being right: the failure this was written for is
 * a codec the TV silently refuses, and silence is exactly what no list can
 * enumerate in advance.
 */

/**
 * Codecs and containers a `<video>` element is trusted to handle directly.
 *
 * Trusted, not verified on the device — the fallback is what makes that
 * acceptable. `matroska` is here because Samsung's engine plays MKV through
 * its native pipeline, which is where a `<video>` on Tizen ends up.
 */
const DIRECT_VIDEO_CODECS = new Set([
  'h264', 'avc1', 'hevc', 'h265', 'vp8', 'vp9', 'av1',
]);

const DIRECT_AUDIO_CODECS = new Set([
  'aac', 'mp3', 'opus', 'vorbis',
]);

const DIRECT_CONTAINERS = new Set([
  'mp4', 'm4v', 'mov', 'matroska', 'webm', 'mpegts', 'ts',
]);

const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * Whether this scene's own file has to be transcoded before it can play.
 *
 * Unknown (`null`, `''`, or a field the query never asked for) is not a
 * verdict: it returns false, and the *stall* fallback in usePlaybackSource is
 * what covers a file whose metadata was silent. Answering "transcode" for
 * every scene whose codec field went missing would push the whole library
 * through ffmpeg to protect against a case the fallback already handles.
 */
export function needsTranscode({ videoCodec, audioCodec, container } = {}) {
  const v = norm(videoCodec);
  const a = norm(audioCodec);
  const c = norm(container);

  if (v && !DIRECT_VIDEO_CODECS.has(v)) return true;
  if (c && !DIRECT_CONTAINERS.has(c)) return true;
  if (a && !DIRECT_AUDIO_CODECS.has(a)) return true;
  return false;
}

/**
 * The timeline the player should draw, given what the element says and what
 * the scene's own metadata says.
 *
 * This exists as a separate function because it is the one part of the second
 * reported bug that could not be reproduced off-device, and so it is the one
 * part that had to be made testable by other means.
 *
 * The bug: *"it doesn't show the actual length of the video (timeline only
 * shows first 10 secs, video continues to play past it but cannot be
 * forwarded)"*. Cause: a Stash MP4 transcode is a linear stream whose
 * container carries no duration (measured: `mvhd timescale=1000 duration=0`),
 * so the TV's engine infers one from the bytes it has received and the
 * timeline grows to ten seconds and stops.
 *
 * The reason this is a *function* rather than an inline guard is that the
 * engine that does this is not available here. Headless Firefox was pointed
 * at every shape that could plausibly defeat a duration measurement — a
 * fragmented MP4 with an empty `moov`, a live WebM with no Duration element,
 * and an endless chunked stream that never closes — and reported the true
 * duration for all three, because it measures the media instead of trusting
 * the container. Which means neither the symptom nor the fix can be watched
 * off-device, in the same category as whether the Tizen IME opens. What *can*
 * be tested is the rule, so the rule lives here, where the harness's K checks
 * reach it, and the component does nothing but read the answer.
 *
 * `0` and `Infinity` are the two unusable values and they need separate
 * treatment: `Infinity` is what an element reports for a stream it cannot
 * measure, and it is *truthy*, so the usual `|| sceneDuration` idiom would let
 * it through and paint a NaN-width bar. `0` covers "not known yet" and "known
 * to be nothing". Neither is a duration, and the scene's own is a better
 * answer than either — it comes from the API, it describes the same source
 * media on both the direct and the transcoded path, and it is what the card
 * the user just left was showing them.
 */
export function timelineDuration(elementDuration, sceneDuration) {
  const el = Number(elementDuration);
  if (Number.isFinite(el) && el > 0) return el;
  const scene = Number(sceneDuration);
  return Number.isFinite(scene) && scene > 0 ? scene : 0;
}

/**
 * Which of Stash's endpoints to prefer, when the direct file is out.
 *
 * **`mime_type` alone does not identify a transcode, and that trap is the
 * whole reason this function reads the URL too.** A real answer from this
 * server (14 endpoints for one scene, 2026-10-16) begins:
 *
 *   video/mp4                      Direct stream   /scene/1957/stream?apikey=…
 *   video/mp4                      MKV             /scene/1957/stream.mkv?apikey=…
 *   video/mp4                      MP4             /scene/1957/stream.mp4?…&resolution=ORIGINAL
 *   video/mp4                      MP4 Standard    …&resolution=STANDARD
 *   video/mp4                      MP4 Low (240p)  …&resolution=LOW
 *   …
 *
 * The first entry is labelled `video/mp4` and *is the unplayable original
 * file* — it is `paths.stream` under another name, which is the very URL this
 * module exists to avoid — and the second is a remux of the same codecs.
 * Every transcode, and nothing else in the list, is a `/stream.<ext>` URL.
 *
 * Both halves of that filter are load-bearing, and the extension is the one
 * that is easy to leave out. Filtering on `mime_type` alone still lands on
 * the right entry *while an ORIGINAL tier is offered*, because the
 * resolution preference below skips the two passthroughs on its way — which
 * is exactly what makes the omission dangerous: it works until the day the
 * server is configured without ORIGINAL, and then the `!LOW` fallback below
 * picks `Direct stream` and the app hands the element back the bytes it had
 * just refused, with nothing on screen to say so. The harness driver's K5
 * checks pin this down; the integration check cannot, because it needs a real
 * transcoded URL to exist in the fixture to observe playback at all.
 *
 * **Ordering: HLS first, and that reverses what this file originally said.**
 * The earlier reasoning ("MP4 first because every engine demuxes and seeks in
 * it") was measured and is wrong — Stash's MP4 transcode is a *linear* stream
 * with no length and no seek support. Probed directly against this server
 * (scene 32807, a real file of 1827.24 s, 2026-10-16):
 *
 *   /stream.mp4?resolution=STANDARD   Transfer-Encoding: chunked
 *                                     Content-Length:    absent
 *                                     Accept-Ranges:     absent
 *                                     mvhd duration:     0  (timescale 1000)
 *                                     Range: bytes=…  →  HTTP 200, no Content-Range
 *   /stream.m3u8?resolution=ORIGINAL  Content-Length:    201997
 *                                     Accept-Ranges:     bytes
 *                                     #EXT-X-PLAYLIST-TYPE:VOD, #EXT-X-ENDLIST
 *                                     914 segments summing to 1827.2 s
 *
 * What that produced on the TV was the reported bug: *"it doesn't show the
 * actual length of the video (timeline only shows first 10 secs, video
 * continues to play past it but cannot be forwarded)"*. A `<video>` with no
 * duration reads one out of the bytes it has so far, so the timeline grew to
 * ~10 s and stopped while playback ran on; and with no byte-range support
 * there is nowhere to seek *to*, so the transport is inert for the whole
 * scene. The MP4 transcode is not a worse seek experience — it has no seek
 * experience. HLS carries the duration in the playlist and addresses the
 * media by byte range, which is the entire difference.
 *
 * WebM stays last: it is the one of the three whose audio Stash encodes with
 * Opus. And MP4 and WebM both *remain*, rather than HLS simply replacing
 * them, because HLS cannot be played by the harness's headless Firefox at all
 * — so "HLS works" is the one claim in this file that no off-device run can
 * make for us, and a single-choice HLS would turn "plays but cannot seek"
 * into "does not play" on any TV that disagrees, silently. Three candidates
 * cost nothing at rest: only the first one is fetched, and the others are one
 * entry each in a list the player already walks.
 *
 * ORIGINAL before the downscales: this is a fallback for an unplayable
 * *codec*, not a bandwidth saver, and a scene that is already 512x384 has
 * nothing to gain from being made smaller.
 *
 * The URLs arrive already carrying `?apikey=…` — unlike `paths.screenshot`,
 * these are not bare — so nothing here goes through `withApiKey`.
 */
const TRANSCODE_FORMATS = [
  ['application/vnd.apple.mpegurl', '.m3u8'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
];

const urlPath = (u) => String(u).split('?')[0].split('#')[0];

/**
 * Every usable transcode URL, best first, at most one per format.
 *
 * A list rather than a single URL so the player can *walk* it: the tiers all
 * transcode the same source, so the failure that justifies a second one is a
 * format the TV won't take (HLS being the one we cannot test off-device),
 * never a resolution — which is why only the best tier of each format is
 * returned and not the whole matrix.
 *
 * An empty list is the ordinary case, not an error: a server with transcoding
 * disabled, or a scene with no file behind it.
 */
export function pickTranscodeUrls(endpoints) {
  const usable = (endpoints || []).filter((e) => e && e.url);
  const urls = [];
  for (const [mime, ext] of TRANSCODE_FORMATS) {
    const group = usable.filter((e) => (
      norm((e.mime_type || '').split(';')[0]) === mime && urlPath(e.url).endsWith(ext)
    ));
    if (!group.length) continue;
    const best = group.find((e) => /resolution=ORIGINAL/i.test(e.url))
      || group.find((e) => !/resolution=LOW/i.test(e.url))
      || group[0];
    urls.push(best.url);
  }
  return urls;
}
