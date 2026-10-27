/**
 * enginePolicy, which playback engine to try, in which order, for a scene.
 *
 * The player drives either the TV's native AVPlay pipeline or the browser's
 * <video>. This module is the whole decision, pure so it tests without either
 * engine: the setting, resolved availability, the per-scene candidate plan and
 * the measured exceptions that reorder it.
 *
 * ## Browser first, TV engine second (`Auto`)
 *
 * `Auto` uses the browser, then AVPlay: the browser seeks better on the files
 * this panel struggles with (a 4K AV1 scene whose AVPlay seeks stalled and
 * failed to resume seeks immediately in the browser). AVPlay is still tried
 * for anything the browser cannot take, and is the native decode path for
 * formats it lacks. `TV` puts AVPlay first for an on-panel A/B; `Browser` is
 * the old browser-only player and the rollback lever.
 *
 * ## Try, do not deny
 *
 * The order is not a claim about decoding. On this panel AVPlay refuses
 * WMV2/WMV3/VC-1, MJPEG, Indeo5 and MS-MPEG4; the browser additionally lacks
 * MPEG-PS/FLV/AVI-demuxable formats. But support is a property of the TV's
 * generation, Samsung dropped WMV, VC-1 and WMA from 2025 models, and older
 * panels may still decode them, and there is no runtime query for it.
 *
 * So there is deliberately no deny list: anything not known to play is still
 * attempted. AVPlay refusals measured at 110–276 ms with no hangs; the
 * browser's are less certain (a source it accepts and sits on only reveals
 * itself to the watchdog), hence the short browser-first watchdog and the
 * mirrored per-format cache. The reactive fallback is the source of truth.
 *
 * The positive list below only describes formats *expected* to work, for the
 * stats panel and tests; it never removes a candidate.
 *
 * ## Measured exceptions
 *
 * 1. A file the browser is known to refuse (`needsTranscode`) goes to AVPlay
 *    direct first even under `Auto`, no point handing the browser a container
 *    or codec it cannot demux (keeps FLV/AVI/MPEG-PS off it).
 * 2. `pcm_s32le` audio in an otherwise-H.264 MP4 (scene 22546): AVPlay refuses
 *    it (~140 ms), the browser plays it. Under `TV` this is the one case where
 *    browser direct goes first; under `Auto` the browser is first anyway. Only
 *    `pcm_s32le` is pre-empted; other PCM layouts were not measured.
 */

import { needsTranscode } from './playbackSource.js';

/**
 * The persisted vocabulary for the Settings lever.
 *
 *   auto   , browser first, AVPlay for what it cannot take (the default)
 *   tv     , AVPlay first, browser as fallback; an on-panel A/B lever so
 *             comparing both on one file needs no rebuild. `tv` is the stored
 *             token only: Settings labels it "TV player".
 *   browser, the old browser-only player and the rollback lever
 */
export const PLAYBACK_ENGINES = ['auto', 'tv', 'browser'];

export function readPlaybackEngine(value) {
  return value === 'browser' || value === 'tv' ? value : 'auto';
}

/**
 * Whether this session may use AVPlay at all. `forcedBrowser` is the
 * build-level rollback (`__FORCE_BROWSER_ENGINE__`), passed in rather than read
 * here so this module stays pure.
 */
export function canUseAvplay({ setting = 'auto', available = false, forcedBrowser = false } = {}) {
  return !forcedBrowser && readPlaybackEngine(setting) !== 'browser' && !!available;
}

const norm = (v) => String(v || '').trim().toLowerCase();

// What AVPlay is *expected* to decode, panel permitting. Informational only:
// see "Try, do not deny" above.
const AVPLAY_LIKELY_VIDEO_CODECS = new Set([
  'h264', 'avc1', 'hevc', 'h265', 'av1', 'vp9', 'mpeg4', 'mpeg2video', 'mpeg1video',
]);

const AVPLAY_LIKELY_CONTAINERS = new Set([
  'mp4', 'm4v', 'mov', 'matroska', 'webm', 'mpegts', 'ts', 'flv', 'mpeg', 'avi',
]);

/**
 * A coarse prediction, not a gate: the stats panel says what was expected, and
 * tests pin the list's shape. A scene this answers false for is still tried.
 */
export function avplayLikelyDirect({ videoCodec, container } = {}) {
  const v = norm(videoCodec);
  const c = norm(container);
  if (v && !AVPLAY_LIKELY_VIDEO_CODECS.has(v)) return false;
  if (c && !AVPLAY_LIKELY_CONTAINERS.has(c)) return false;
  return true;
}

/**
 * The one measured browser-first case: scene 22546, H.264 + `pcm_s32le` in an
 * MP4. AVPlay refused it in ~140 ms; the browser plays it. Only matters under
 * `tv`, `auto` already starts on the browser.
 */
export function preferBrowserDirect({ audioCodec } = {}) {
  return norm(audioCodec) === 'pcm_s32le';
}

/**
 * Whether an engine needs the scene pre-emptively transcoded.
 *
 * False for AVPlay: pre-empting would reintroduce the deny list this module
 * exists to avoid, and its transcode candidates still follow the direct ones.
 * The name survives because callers ask one question, "should this engine's
 * direct candidate be skipped?", and this answers it for each engine.
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
 * The ordered candidates for one scene, as descriptors; the caller attaches
 * the URL-producing `make` to each, this module never fetches.
 *
 * Browser (or no AVPlay):
 *   transcode needed → transcode, direct; otherwise direct, transcode
 * Auto (browser first):
 *   ordinary        → browser direct, AVPlay direct, browser transcode, AVPlay transcode
 *   browser-refused → AVPlay direct, AVPlay transcode, browser transcode, browser direct
 *   pcm_s32le       → the ordinary order (the browser is already first)
 * TV (AVPlay first):
 *   ordinary        → AVPlay direct, browser direct, AVPlay transcode, browser transcode
 *   browser-refused → AVPlay direct, AVPlay transcode, browser transcode, browser direct
 *   pcm_s32le       → browser direct, AVPlay direct, browser transcode, AVPlay transcode
 *
 * Each engine's transcodes stay together: a transcode refusal is retried under
 * the other engine before a second format is fetched from Stash. The preferred
 * engine's transcode comes first.
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

  // The measured exception outranks every other rule: `needsTranscode` calls
  // this file non-browser-direct (the audio layout is outside the allowlist),
  // but AVPlay refuses it and the browser plays it.
  if (preferBrowserDirect(video)) {
    return [BROWSER_DIRECT, AVPLAY_DIRECT, BROWSER_TRANSCODE, AVPLAY_TRANSCODE];
  }

  // A file the browser cannot demux goes to the native engine first even when
  // the browser is preferred, this keeps FLV, AVI and MPEG-PS off it.
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
 * candidates may carry the same URL (an engine fallback re-opens the stream
 * under another backend), so without the engine in the key the re-arm never
 * happens and the player stays on the dead engine's last events.
 */
export function sourceKey(engine, src) {
  return `${engine || 'none'}:${src || ''}`;
}

/**
 * The session kill switch: two *engine-level* failures on different scenes
 * turn AVPlay off for the session; content refusals never count. Keyed by
 * scene, not URL, one scene's transcodes can fail for reasons that say
 * nothing about the engine, and the plan keeps those out of the count.
 */
export function createEngineHealth({ limit = 2 } = {}) {
  const failedScenes = new Set();
  let disabled = false;
  let lastReason = '';

  return {
    disabled() { return disabled; },
    reason() { return lastReason; },
    /**
     * Record one engine-level failure. True when this failure disabled AVPlay,
     * so the caller can surface it.
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
