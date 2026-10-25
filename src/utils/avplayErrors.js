/**
 * avplayErrors — what an AVPlay failure means, decided by *when* it happened.
 *
 * AVPlay reports almost everything as a generic code. The probe found a codec
 * this panel cannot decode surfaces as `PLAYER_ERROR_CONNECTION_FAILED` — the
 * same family as a dropped stream — so the code alone cannot separate "file
 * not playable here" from "engine broken". Both mistakes are expensive:
 * treating a refusal as an engine fault trips the session kill switch after
 * two scenes, and treating a broken engine as a refusal retries forever.
 *
 * The phase is the reliable signal:
 *
 *   open      | open/setListener threw before any media was accepted → engine
 *   prepare   | refused before the first frame → content (try the next candidate)
 *   play      | prepared but play() failed → content
 *   runtime   | stream failed after playing → content
 *   seek      | a seek failed while playback continued → transient (degraded)
 *   lifecycle | suspend/restore failed → engine
 *
 * Named errors for genuine engine faults win over the phase rule: "invalid
 * state" during prepare is an engine bug, not a bad file. Unknown errors fall
 * back to the phase. The numeric table is a second fallback for panels that
 * report numbers without names, never preferred because those values have not
 * been stable across Tizen versions.
 */

export const AVPLAY_PHASES = ['open', 'prepare', 'play', 'runtime', 'seek', 'lifecycle'];

// Faults that are the engine's problem wherever they appear.
const ENGINE_NAMES = new Set([
  'PLAYER_ERROR_INVALID_PARAMETER',
  'PLAYER_ERROR_INVALID_OPERATION',
  'PLAYER_ERROR_OUT_OF_MEMORY',
  'PLAYER_ERROR_INVALID_STATE',
  'PLAYER_ERROR_TIMEOUT',
  // Our own 6 s prepare watchdog, not an AVPlay name.
  'PREPARE_TIMEOUT',
]);

// Faults that describe the content, wherever they appear.
const CONTENT_NAMES = new Set([
  'PLAYER_ERROR_NO_SUCH_FILE',
  'PLAYER_ERROR_NOT_SUPPORTED_FILE',
  'PLAYER_ERROR_NOT_SUPPORTED_FORMAT',
  'PLAYER_ERROR_CONNECTION_FAILED',
  'PLAYER_ERROR_NOT_AVAILABLE',
]);

// Numeric fallback. Only the values documented across Tizen 5–9 are listed;
// anything absent stays phase-classified.
const BY_CODE = new Map([
  [-1, 'engine'],   // invalid parameter
  [-2, 'content'],  // no such file
  [-3, 'engine'],   // invalid operation
  [-4, 'engine'],   // out of memory
  [-5, 'content'],  // not supported file
  [-6, 'engine'],   // invalid state
  [-7, 'content'],  // connection failed
  [-9, 'content'],  // not supported format
]);

const normName = (name) => String(name || '').trim().toUpperCase();

/**
 * Classify one failure.
 *
 * @param {{ phase?: string, name?: string, code?: number, message?: string }} raw
 * @returns {{ level: 'engine'|'content'|'transient', phase: string,
 *             name: string, code: number|null, message: string }}
 */
export function classifyAvplayError({ phase = 'runtime', name = '', code = null, message = '' } = {}) {
  const named = normName(name);
  const phaseOut = AVPLAY_PHASES.includes(phase) ? phase : 'runtime';

  const numeric = Number.isFinite(code) ? BY_CODE.get(code) : undefined;

  let level;
  if (phaseOut === 'seek') {
    // A failed seek while the picture keeps playing is not a verdict on the
    // file or the engine; the coalescer retries and reports degradation.
    level = 'transient';
  } else if (ENGINE_NAMES.has(named)) {
    level = 'engine';
  } else if (CONTENT_NAMES.has(named)) {
    level = 'content';
  } else if (numeric) {
    // Third choice: no usable name, but a documented number.
    level = numeric;
  } else if (phaseOut === 'open' || phaseOut === 'lifecycle') {
    // A throw from open/setListener has no code and is the engine's fault.
    level = 'engine';
  } else {
    // prepare/play/runtime with nothing to identify the fault: treat it as
    // content, so an unexplained refusal advances rather than disabling the
    // engine.
    level = 'content';
  }

  return {
    level,
    phase: phaseOut,
    name: named,
    code: Number.isFinite(code) ? code : null,
    message: String(message || ''),
  };
}

/**
 * Whether a failure says something about AVPlay itself, and so counts toward
 * the session kill switch. Transient seek failures never do.
 */
export function isEngineLevel(result) {
  return !!result && result.level === 'engine';
}

/** A short phrase for the stats panel / engine-aware error message. */
export function describeAvplayFailure(result) {
  if (!result) return 'unknown playback error';
  const where = result.phase === 'prepare' ? 'while preparing'
    : result.phase === 'open' ? 'while opening the player'
      : result.phase === 'seek' ? 'during a seek'
        : 'during playback';
  if (result.level === 'content') return `the TV refused this file ${where}`;
  if (result.level === 'transient') return `a seek failed ${where}`;
  return `the TV's player failed ${where}${result.name ? ` (${result.name})` : ''}`;
}

/**
 * The resolution band a refusal is scoped to.
 *
 * A panel can decode 1080p AV1 and refuse 4K, so resolution belongs in the key;
 * exact pixels would fragment the cache per file. The short edge treats both
 * orientations alike. Empty when Stash reports no dimensions — callers keep
 * that as a coarser key rather than pretending to know.
 */
export function resolutionBand({ width, height } = {}) {
  const w = Number(width);
  const h = Number(height);
  const usable = (n) => Number.isFinite(n) && n > 0;
  let edge;
  if (usable(w) && usable(h)) edge = Math.min(w, h);
  else if (usable(h)) edge = h;
  else if (usable(w)) edge = w;
  else return '';
  if (edge >= 2000) return '4k';
  if (edge >= 1400) return '1440';
  if (edge >= 900) return '1080';
  if (edge >= 600) return '720';
  return 'sd';
}

/**
 * The negative cache key for a direct-play refusal.
 *
 * Container + video codec + audio codec is what a panel actually refuses:
 * WMV2 in AVI and in ASF can behave differently, and H.264 + pcm_s32le fails
 * where H.264 + AAC does not. Resolution is appended when known, so a refused
 * 4K file cannot exile the codec at 1080p.
 *
 * `null` unless **both codecs are known**: `mp4||` would be shared by every
 * unprobed scene, turning the first refusal into a blanket verdict. A file
 * with a known video but unknown audio (metadata still arriving, an unnamed
 * silent track) is retried rather than cached.
 */
export function avplayFormatKey({ container, videoCodec, audioCodec, width, height } = {}) {
  const v = String(videoCodec || '').trim().toLowerCase();
  const a = String(audioCodec || '').trim().toLowerCase();
  const c = String(container || '').trim().toLowerCase();
  if (!v || !a) return null;
  const band = resolutionBand({ width, height });
  return band ? `${c}|${v}|${a}|${band}` : `${c}|${v}|${a}`;
}
