#!/usr/bin/env node
/**
 * test-avplay-errors.mjs — separating "this file is refused" from "the engine
 * is broken"
 *
 *   node scripts/test-avplay-errors.mjs
 *
 * AVPlay reports a refused codec as PLAYER_ERROR_CONNECTION_FAILED, the same
 * family as a dropped stream; the phase distinguishes them. Calling a refusal
 * an engine fault disables AVPlay after two scenes (the session kill switch),
 * and calling a broken engine a refusal retries a dead backend forever. Both
 * directions are pinned here.
 */

import {
  classifyAvplayError,
  isEngineLevel,
  describeAvplayFailure,
  avplayFormatKey,
  resolutionBand,
} from '../src/utils/avplayErrors.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const level = (raw) => classifyAvplayError(raw).level;

// ── The measured misreport ─────────────────────────────────
check('a refused codec at prepare is content, not engine',
  level({ phase: 'prepare', name: 'PLAYER_ERROR_CONNECTION_FAILED' }) === 'content');
check('the same code after a frame is still content',
  level({ phase: 'runtime', name: 'PLAYER_ERROR_CONNECTION_FAILED' }) === 'content');
check('a numeric connection code is content',
  level({ phase: 'prepare', code: -7 }) === 'content');

// ── Named engine faults win over the phase ─────────────────
check('invalid state during prepare is the engine',
  level({ phase: 'prepare', name: 'PLAYER_ERROR_INVALID_STATE' }) === 'engine');
check('invalid parameter during prepare is the engine',
  level({ phase: 'prepare', name: 'PLAYER_ERROR_INVALID_PARAMETER' }) === 'engine');
check('out of memory at runtime is the engine',
  level({ phase: 'runtime', name: 'PLAYER_ERROR_OUT_OF_MEMORY' }) === 'engine');
check('a prepare timeout is the engine',
  level({ phase: 'prepare', name: 'PREPARE_TIMEOUT' }) === 'engine');
check('numeric invalid state is the engine',
  level({ phase: 'prepare', code: -6 }) === 'engine');

// ── Phase fallbacks ────────────────────────────────────────
check('a throw while opening has no code and is the engine',
  level({ phase: 'open' }) === 'engine');
check('a failed suspend/restore is the engine',
  level({ phase: 'lifecycle', name: 'anything' }) === 'engine');
check('an unexplained refusal at prepare is content',
  level({ phase: 'prepare' }) === 'content');
check('an unexplained runtime failure is content',
  level({ phase: 'runtime' }) === 'content');
check('an unknown phase behaves as runtime',
  level({ phase: 'nonsense' }) === 'content');
check('empty input does not throw', level() === 'content');

// ── Seek failures are transient, never a verdict ───────────
check('a seek failure is transient',
  level({ phase: 'seek', name: 'PLAYER_ERROR_CONNECTION_FAILED' }) === 'transient');
check('a seek failure with an engine name is still transient',
  level({ phase: 'seek', name: 'PLAYER_ERROR_INVALID_STATE' }) === 'transient');
check('a transient is not engine-level',
  isEngineLevel(classifyAvplayError({ phase: 'seek' })) === false);

// ── The result shape ───────────────────────────────────────
{
  const r = classifyAvplayError({ phase: 'prepare', name: ' player_error_invalid_state ', code: -6, message: 'boom' });
  check('the name is normalised', r.name === 'PLAYER_ERROR_INVALID_STATE');
  check('the code is preserved', r.code === -6);
  check('the message is preserved', r.message === 'boom');
  check('the phase is preserved', r.phase === 'prepare');
  check('engine-level is reported', isEngineLevel(r) === true);
}
{
  const r = classifyAvplayError({ phase: 'prepare', code: undefined });
  check('a non-numeric code becomes null', r.code === null);
}

// ── Human-readable reasons ─────────────────────────────────
{
  const refused = classifyAvplayError({ phase: 'prepare', name: 'PLAYER_ERROR_CONNECTION_FAILED' });
  const broken = classifyAvplayError({ phase: 'open' });
  const seek = classifyAvplayError({ phase: 'seek' });
  check('content says the TV refused the file',
    describeAvplayFailure(refused).includes('refused this file'));
  check('engine says the player failed',
    describeAvplayFailure(broken).includes("player failed"));
  check('seek says a seek failed',
    describeAvplayFailure(seek).includes('seek failed'));
  check('no result is describable', typeof describeAvplayFailure(null) === 'string');
}

// ── Negative-cache keys ────────────────────────────────────
{
  check('the key is container|video|audio',
    avplayFormatKey({ container: 'AVI', videoCodec: 'WMV2', audioCodec: 'wmav2' }) === 'avi|wmv2|wmav2');
  check('codecs matter, not just the container',
    avplayFormatKey({ container: 'avi', videoCodec: 'wmv2', audioCodec: 'wmav2' })
      !== avplayFormatKey({ container: 'avi', videoCodec: 'mpeg4', audioCodec: 'aac' }));
  check('audio alone is enough to distinguish',
    avplayFormatKey({ container: 'mp4', videoCodec: 'h264', audioCodec: 'pcm_s32le' })
      !== avplayFormatKey({ container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' }));
  check('no metadata is not a cache key',
    avplayFormatKey({}) === null);
  check('an unknown file is not cached under a shared key',
    avplayFormatKey({ container: null, videoCodec: '', audioCodec: undefined }) === null);

  // A partial triple is not coarser — it is a shared key. `mp4||` written by
  // the first unprobed scene to fail is then read by every other, turning one
  // refusal into a session-wide verdict.
  check('a known container and video but unknown audio is not a key',
    avplayFormatKey({ container: 'mp4', videoCodec: 'h264' }) === null);
  check('a known video and audio but unknown container is a key',
    avplayFormatKey({ videoCodec: 'h264', audioCodec: 'aac' }) === '|h264|aac');
  check('a known audio and container but unknown video is not a key',
    avplayFormatKey({ container: 'mp4', audioCodec: 'aac' }) === null);
}

// ── Resolution bands ───────────────────────────────────────
{
  check('a 1080p short edge is 1080', resolutionBand({ width: 1920, height: 1080 }) === '1080');
  check('the short edge classifies portrait the same way',
    resolutionBand({ width: 1080, height: 1920 }) === '1080');
  check('4K is 4k', resolutionBand({ width: 3840, height: 2160 }) === '4k');
  check('1440 is 1440', resolutionBand({ width: 2560, height: 1440 }) === '1440');
  check('720 is 720', resolutionBand({ width: 1280, height: 720 }) === '720');
  check('below 720 is sd', resolutionBand({ width: 720, height: 480 }) === 'sd');
  check('height alone is enough', resolutionBand({ height: 2160 }) === '4k');
  check('width alone is enough', resolutionBand({ width: 3840 }) === '4k');
  check('no dimensions is no band', resolutionBand({}) === '');
  check('zero is not a dimension', resolutionBand({ width: 0, height: 0 }) === '');
  check('a non-number is not a dimension', resolutionBand({ width: '1080p', height: null }) === '');

  // The point of the band: one refused 4K file must not exile 1080p.
  check('4K and 1080p of the same codecs are different keys',
    avplayFormatKey({ container: 'mp4', videoCodec: 'av1', audioCodec: 'aac', width: 3840, height: 2160 })
      !== avplayFormatKey({ container: 'mp4', videoCodec: 'av1', audioCodec: 'aac', width: 1920, height: 1080 }));
  check('the band is appended to the codec triple',
    avplayFormatKey({ container: 'mp4', videoCodec: 'av1', audioCodec: 'aac', width: 3840, height: 2160 })
      === 'mp4|av1|aac|4k');
  check('no dimensions keeps the coarser key',
    avplayFormatKey({ container: 'mp4', videoCodec: 'av1', audioCodec: 'aac' }) === 'mp4|av1|aac');
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
