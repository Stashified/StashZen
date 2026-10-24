/**
 * enginePolicy — which playback engine to try, in which order, for a scene.
 *
 * The player can drive either the TV's native AVPlay pipeline or the
 * browser's <video> element. This module is the whole decision, kept pure so
 * it can be tested without either engine: the settings value that enables
 * AVPlay, whether this device actually has it, the per-scene candidate plan,
 * and the two measured exceptions that reorder it.
 *
 * ## Browser first, TV engine second (`Auto`)
 *
 * `Auto` is the browser, then the TV's native engine. The browser is the
 * default because it seeks better on the files this panel struggles with
 * (2026-10-23: a 4K AV1 scene whose AVPlay seeks stalled, then failed to
 * resume, seeks immediately in the browser). AVPlay is not dropped: it is
 * tried for every file the browser cannot take, and it is the native decode
 * path for formats the browser lacks. `TV` puts AVPlay first for an on-panel
 * A/B, and `Browser` is exactly the pre-0.36 player and the rollback lever.
 *
 * ## Try, do not deny
 *
 * The ordering is **not** a claim about what either engine can decode. On this
 * panel AVPlay refuses WMV2/WMV3/VC-1, MJPEG, Indeo5 and MS-MPEG4; the browser
 * additionally lacks MPEG-PS/FLV/AVI-demuxable formats. But format support is
 * a property of the TV's generation, not of the API — Samsung's own specs say
 * WMV, VC-1 and WMA were dropped from the 2025 models onward, and older panels
 * may still decode them — and there is no runtime query for "what can this
 * panel decode".
 *
 * So there is deliberately **no deny list**. Anything not known to play is
 * still attempted. The Phase 0 probe measured AVPlay refusals at 110–276 ms
 * with no hangs; the browser's refusals are less certain (a source it accepts
 * and sits on only gives itself away to the watchdog), which is why the
 * browser-first watchdog is short and a per-format cache mirrors AVPlay's.
 * The reactive fallback is the source of truth in both directions.
 *
 * The positive list below therefore has one job: describing which formats are
 * *expected* to work, for the stats panel and for tests. It never removes a
 * candidate.
 *
 * ## The measured exceptions and the ordering rules
 *
 * 1. A file the browser is known to refuse (`needsTranscode`) is handed to
 *    AVPlay's direct candidate first even in `Auto`: there is no reason to
 *    give the browser a container or codec it cannot demux. This is the rule
 *    that keeps the library's FLV/AVI/MPEG-PS scenes off the browser.
 * 2. `pcm_s32le` audio in an otherwise-H.264 MP4 (scene 22546): AVPlay refuses
 *    it, the browser plays it. Under `TV` this is the one case where the
 *    browser's direct candidate goes first. Under `Auto` the browser is
 *    first anyway. Only `pcm_s32le` is pre-empted; other PCM layouts were not
 *    measured, so they stay unknown.
 */

import { needsTranscode } from './playbackSource.js';

/**
 * The persisted vocabulary for the Settings lever.
 *
 *   auto    — the browser first, the TV's engine for what it cannot take
 *             (the default, and what this module calls browser-first)
 *   tv      — AVPlay first, the browser as fallback. An on-panel A/B lever;
 *             the seek fix that made the browser the default is recent, and
 *             comparing the two on the same file should not need a rebuild.
 *             `tv` is the stored token only: Settings labels it "TV player".
 *   browser — exactly the pre-0.36 player and the rollback lever
 */
export const PLAYBACK_ENGINES = ['auto', 'tv', 'browser'];

export function readPlaybackEngine(value) {
  return value === 'browser' || value === 'tv' ? value : 'auto';
}

/**
 * Whether this session may use AVPlay at all.
 *
 * `forcedBrowser` is the build-level rollback (`__FORCE_BROWSER_ENGINE__`),
 * passed by the caller rather than read here so this module stays pure.
 */
export function canUseAvplay({ setting = 'auto', available = false, forcedBrowser = false } = {}) {
  return !forcedBrowser && readPlaybackEngine(setting) !== 'browser' && !!available;
}

const norm = (v) => String(v || '').trim().toLowerCase();

// What AVPlay is *expected* to decode, panel permitting. Informational only —
// see "Try, do not deny" above.
const AVPLAY_LIKELY_VIDEO_CODECS = new Set([
  'h264', 'avc1', 'hevc', 'h265', 'av1', 'vp9', 'mpeg4', 'mpeg2video', 'mpeg1video',
]);

const AVPLAY_LIKELY_CONTAINERS = new Set([
  'mp4', 'm4v', 'mov', 'matroska', 'webm', 'mpegts', 'ts', 'flv', 'mpeg', 'avi',
]);

/**
 * A coarse prediction, not a gate. Used by the stats panel to say what was
 * expected and by tests to pin the list's shape; a scene this answers false for
 * is still tried directly.
 */
export function avplayLikelyDirect({ videoCodec, container } = {}) {
  const v = norm(videoCodec);
  const c = norm(container);
  if (v && !AVPLAY_LIKELY_VIDEO_CODECS.has(v)) return false;
  if (c && !AVPLAY_LIKELY_CONTAINERS.has(c)) return false;
  return true;
}

/**
 * The one measured browser-first case. Scene 22546: H.264 + `pcm_s32le` in an
 * MP4. AVPlay refused it in ~140 ms; the browser plays it. Only meaningful
 * under the `tv` setting — `auto` already starts on the browser.
 */
export function preferBrowserDirect({ audioCodec } = {}) {
  return norm(audioCodec) === 'pcm_s32le';
}

/**
 * Whether an engine needs the scene pre-emptively transcoded.
 *
 * For the browser this is today's rule, unchanged. For AVPlay it is always
 * false: pre-empting would reintroduce the static deny list this module
 * exists to avoid, and the transcode candidates are still in the plan after
 * the direct ones. The name is kept because callers ask one question —
 * "should this engine's direct candidate be skipped?" — and this is its
 * answer for each.
 */
export function needsTranscodeForEngine(video, engine) {
  if (engine === 'avplay') return false;
  return needsTranscode(video);
}

const AVPLAY_DIRECT = { engine: 'avplay', kind: 'direct' };
const BROWSER_DIRECT = { engine: 'html5', kind: 'direct' };
const AVPLAY_TRANSCODE = { engine: 'avplay', kind: 'transcode' };
const BROWSER_TRANSCODE = { engine: 'html5', kind: 'transcode' };

/**
 * The ordered candidates for one scene, as descriptors. The caller attaches
 * the URL-producing `make` function to each — this module never fetches.
 *
 * `Browser` (or no AVPlay) reproduces today's order exactly:
 *   transcode needed → transcode, direct
 *   otherwise        → direct, transcode
 *
 * `Auto` with AVPlay available (browser first):
 *   ordinary         → browser direct, AVPlay direct, browser transcode, AVPlay transcode
 *   browser-refused  → AVPlay direct, AVPlay transcode, browser transcode, browser direct
 *   pcm_s32le        → the ordinary order (the browser is already first)
 *
 * `TV` with AVPlay available (AVPlay first):
 *   ordinary         → AVPlay direct, browser direct, AVPlay transcode, browser transcode
 *   browser-refused  → AVPlay direct, AVPlay transcode, browser transcode, browser direct
 *   pcm_s32le        → browser direct, AVPlay direct, browser transcode, AVPlay transcode
 *
 * Each engine's transcodes stay together rather than interleaving with the
 * other engine's: a transcode refusal is retried under the other engine before
 * a second format is fetched from Stash. In `Auto` the browser's transcode
 * comes first because the browser is the preferred engine; in `TV` AVPlay's
 * does, for the same reason.
 */
export function buildCandidatePlan({ video, setting = 'auto', available = false, forcedBrowser = false } = {}) {
  const useAvplay = canUseAvplay({ setting, available, forcedBrowser });

  if (!useAvplay) {
    const transcodeFirst = needsTranscode(video);
    return transcodeFirst
      ? [BROWSER_TRANSCODE, BROWSER_DIRECT]
      : [BROWSER_DIRECT, BROWSER_TRANSCODE];
  }

  const mode = readPlaybackEngine(setting);

  // The measured exception outranks every other rule. `needsTranscode` is
  // right that this file is not browser-direct in the static sense (the audio
  // layout is outside the allowlist), but AVPlay was measured refusing it while
  // the browser plays it — so the browser stays the first attempt in both
  // modes.
  if (preferBrowserDirect(video)) {
    return [BROWSER_DIRECT, AVPLAY_DIRECT, BROWSER_TRANSCODE, AVPLAY_TRANSCODE];
  }

  // A file the browser cannot demux goes to the native engine first even when
  // the browser is the preferred one. This is the rule that keeps FLV, AVI and
  // MPEG-PS off a browser attempt.
  if (needsTranscode(video)) {
    return [AVPLAY_DIRECT, AVPLAY_TRANSCODE, BROWSER_TRANSCODE, BROWSER_DIRECT];
  }

  if (mode === 'tv') {
    return [AVPLAY_DIRECT, BROWSER_DIRECT, AVPLAY_TRANSCODE, BROWSER_TRANSCODE];
  }

  return [BROWSER_DIRECT, AVPLAY_DIRECT, BROWSER_TRANSCODE, AVPLAY_TRANSCODE];
}

/**
 * The identity of a source *including its engine*.
 *
 * The player re-arms its media wiring whenever the source string changes. Two
 * candidates may carry the same URL — an engine fallback re-opens the same
 * stream under the other backend — so the key has to include the engine or
 * the re-arm silently does not happen and the player stays on the dead
 * engine's last events.
 */
export function sourceKey(engine, src) {
  return `${engine || 'none'}:${src || ''}`;
}

/**
 * The session kill switch. Two *engine-level* failures on different scenes
 * turn AVPlay off for the rest of the session; content refusals never count,
 * because those are what the fallback is for.
 *
 * Different scenes, not different URLs: one scene's transcodes can fail for
 * reasons that say nothing about the engine, and the plan explicitly keeps
 * those out of the count.
 */
export function createEngineHealth({ limit = 2 } = {}) {
  const failedScenes = new Set();
  let disabled = false;
  let lastReason = '';

  return {
    disabled() { return disabled; },
    reason() { return lastReason; },
    /**
     * Record one engine-level failure. Returns true when this failure was the
     * one that disabled AVPlay, so the caller can surface it.
     */
    fail(sceneId, reason = 'engine error') {
      if (disabled) return false;
      if (sceneId != null) failedScenes.add(String(sceneId));
      const count = sceneId != null ? failedScenes.size : limit;
      if (count >= limit) {
        disabled = true;
        lastReason = reason;
        return true;
      }
      return false;
    },
    /** A successful prepare proves the engine works; clear the count. */
    succeed() {
      if (disabled) return;
      failedScenes.clear();
    },
  };
}
