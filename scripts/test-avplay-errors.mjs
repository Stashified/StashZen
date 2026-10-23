#!/usr/bin/env node
/**
 * test-avplay-errors.mjs — separating "this file is refused" from "the engine
 * is broken"
 *
 *   node scripts/test-avplay-errors.mjs
 *
 * AVPlay reports a refused codec as PLAYER_ERROR_CONNECTION_FAILED, the same
 * fault family as a dropped stream. The phase is what distinguishes them.
 * Misclassifying a refusal as an engine fault disables AVPlay after two scenes
 * (the session kill switch); misclassifying a broken engine as a refusal makes
 * the player retry a dead backend forever. Both directions are pinned here.
 *
 * No framework.
 */

import {
  classifyAvplayError,
  isEngineLevel,
  describeAvplayFailure,
  avplayFormatKey,
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
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
