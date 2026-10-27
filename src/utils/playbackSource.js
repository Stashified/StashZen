/**
 * playbackSource, what the player hands the <video>, and when a scene must go
 * through Stash's transcoder instead of its own file.
 *
 * Stash serves the file it has: `paths.stream` is that file, container and
 * codecs included. A TV pipeline decodes far more than a `<video>` element, and
 * this app plays through a `<video>`, so "plays in Stash's web UI" and "plays
 * in VLC" say nothing about here. Measured against this library (5,836 scenes,
 * counted from the API):
 *
 *     video      h264 4292 · av1 837 · hevc 265 · wmv2 223 · mpeg4 99
 *                wmv3 94 · mpeg1video 29 · mjpeg 9 · indeo5 1 · msmpeg4v3 1
 *     audio      aac 5472 · wmav2 317 · mp1 16 · mp3 13 · ac3 6 · dts 3 …
 *     container  mp4 5341 · wmv 317 · matroska 138 · mpeg 29 · avi 24 · flv 1
 *
 * MS-MPEG4 v2/v3, WMV (v2 is a RealVideo-derived SP, v3 is VC-1), MPEG-4
 * Part 2/Xvid, MPEG-1 and MJPEG are outside any Chromium engine; `wmv`, `avi`,
 * `mpeg` (program stream) and `flv` it will not demux either. Stash re-encodes
 * on demand, and `sceneStreams(id)` advertises the results.
 *
 * Two halves, deliberately different kinds of guess:
 *  1. `needsTranscode` is *pre-emptive* and fires only on a codec we are sure
 *     is unplayable. An absent field means "no opinion", a wrong pre-emptive
 *     answer costs a transcode the server has to run.
 *  2. The player's error/stall fallback (usePlaybackSource) is *reactive* and
 *     covers what the list gets wrong in either direction.
 *
 * The second half makes the first safe to get wrong: the target failure is a
 * codec the TV silently refuses, and silence is what no list can enumerate.
 */

/**
 * Codecs and containers a `<video>` element is trusted to handle directly.
 *
 * Trusted, not verified on the device, the fallback makes that acceptable.
 * `matroska` is here because Samsung's engine plays MKV through its native
 * pipeline, where a `<video>` on Tizen ends up.
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
 * Unknown (`null`, `''`, or an unasked field) is not a verdict: returns false,
 * and the *stall* fallback in usePlaybackSource covers silent metadata.
 * Answering "transcode" there would push the whole library through ffmpeg.
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
 * A Stash MP4 transcode is a linear stream whose container carries no duration
 * (measured: `mvhd timescale=1000 duration=0`), so the TV infers one from the
 * bytes received and the timeline stops at ~10 s while playback runs on. The
 * rule lives in a function because that engine is unavailable here and headless
 * Firefox measures the media instead (fragmented MP4, live WebM and endless
 * chunked streams all report a true duration), so neither symptom nor fix is
 * observable off-device; only the rule is testable, via the harness's K checks.
 *
 * `0` and `Infinity` need separate treatment: `Infinity` is truthy, so the
 * usual `|| sceneDuration` idiom would let it through and paint a NaN-width
 * bar; `0` means "not known yet" or "known to be nothing". The scene's own
 * duration, from the API, describing the same source media on both paths, is
 * a better answer than either.
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
 * **`mime_type` alone does not identify a transcode**, which is why this reads
 * the URL too. Of this server's 14 endpoints for one scene, the first is
 * labelled `video/mp4` and *is the unplayable original*, `paths.stream` under
 * another name, the very URL this module avoids, and the second is a remux of
 * the same codecs. Every real transcode, and nothing else, is a `/stream.<ext>`
 * URL. Both halves are load-bearing: filtering on mime alone still works while
 * an ORIGINAL tier exists (the resolution preference skips the passthroughs),
 * and breaks the day it does not, when the `!LOW` fallback selects
 * `Direct stream`, the bytes just refused, silently. The harness's K5 checks
 * pin this down; the integration check cannot.
 *
 * **Ordering: HLS first.** Stash's MP4 transcode is a *linear* stream with no
 * length and no seek support. Probed on a 1827.24 s scene: `/stream.mp4` uses
 * chunked transfer with no Content-Length or Accept-Ranges, `mvhd
 * duration=0` (timescale 1000), and a Range request answers 200 without
 * Content-Range, so the TV infers a ~10 s timeline that stops while playback
 * runs on, with nowhere to seek. `/stream.m3u8` has `Content-Length` 201997,
 * `Accept-Ranges: bytes`, VOD with `#EXT-X-ENDLIST` and 914 segments summing to
 * 1827.2 s. HLS carries the duration in the playlist and addresses media by
 * byte range, which is the entire difference.
 *
 * MP4 and WebM remain after HLS because headless Firefox cannot play HLS at
 * all, so "HLS works" is the one claim no off-device run can make; a
 * single-choice HLS would turn "plays but cannot seek" into "does not play"
 * silently on a TV that disagrees. Three candidates cost nothing at rest: only
 * the first is fetched. WebM is last because Stash encodes its audio with Opus.
 *
 * ORIGINAL before the downscales: this is a fallback for an unplayable *codec*,
 * not a bandwidth saver, and a 512x384 scene gains nothing from shrinking.
 *
 * The URLs already carry `?apikey=…`, unlike `paths.screenshot`, so nothing
 * here goes through `withApiKey`.
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
 * A list so the player can *walk* it: all tiers transcode the same source, so
 * a second attempt is justified by a format the TV won't take (HLS being the
 * one untestable off-device), never a resolution, hence only each format's
 * best tier, not the whole matrix.
 *
 * An empty list is ordinary: transcoding disabled, or no file behind the scene.
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
