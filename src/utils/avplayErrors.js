/**
 * avplayErrors — what an AVPlay failure means, decided by *when* it happened.
 *
 * AVPlay reports almost everything as a generic code. The Phase 0 probe found
 * that a codec this panel cannot decode surfaces as
 * `PLAYER_ERROR_CONNECTION_FAILED` — the same family a dropped network stream
 * would use — so the code alone cannot separate "this file is not playable
 * here" from "the engine is broken". Getting that wrong is expensive in both
 * directions: treating a refusal as an engine fault trips the session kill
 * switch after two scenes, and treating a broken engine as a refusal leaves
 * the player retrying AVPlay forever.
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
 * Named errors for genuine engine faults win over the phase rule, because
 * "invalid state" during prepare is an engine bug, not a bad file. Unknown
 * errors fall back to the phase. The numeric table is a second fallback for
 * panels that report numbers without names; it is never preferred, because
 * the numeric values have never been promised stable across Tizen versions.
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
 * The negative cache key for a direct-play refusal.
 *
 * Container + video codec + audio codec, because that triple is what a panel
 * actually refuses: WMV2 in AVI and WMV2 in ASF can behave differently, and
 * H.264 + pcm_s32le fails where H.264 + AAC does not. `null` when nothing is
 * known, so an unidentifiable file is retried rather than cached under a
 * meaningless key.
 */
export function avplayFormatKey({ container, videoCodec, audioCodec } = {}) {
  const v = String(videoCodec || '').trim().toLowerCase();
  const a = String(audioCodec || '').trim().toLowerCase();
  const c = String(container || '').trim().toLowerCase();
  if (!v && !a && !c) return null;
  return `${c}|${v}|${a}`;
}
