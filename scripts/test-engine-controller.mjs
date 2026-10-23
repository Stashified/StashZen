#!/usr/bin/env node
/**
 * test-engine-controller.mjs — the session's engine memory.
 *
 *   node scripts/test-engine-controller.mjs
 *
 * Pins three rules that the source resolver depends on and that are easy to
 * get subtly wrong:
 *
 *   - content refusals never disable AVPlay, and engine-level ones do so only
 *     after two *different* scenes
 *   - the negative cache is per format and only for direct attempts
 *   - the status code reports the first reason that applies, in a fixed order
 */

import {
  createEngineController, describeEngine, ENGINE_STATUS,
} from '../src/utils/engineController.js';

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

const WMV = { container: 'avi', videoCodec: 'wmv2', audioCodec: 'wmav2' };
const H264 = { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' };
const H264_PCM = { container: 'mp4', videoCodec: 'h264', audioCodec: 'pcm_s32le' };

// ── Status precedence ────────────────────────────────────
{
  const c = createEngineController();
  check('the setting wins over everything',
    c.status({ setting: 'browser', available: true }) === ENGINE_STATUS.BROWSER_SETTING);
  check('the build flag wins over the setting',
    c.status({ setting: 'auto', available: true, forcedBrowser: true }) === ENGINE_STATUS.FORCED_BROWSER);
  check('an unavailable panel says so',
    c.status({ setting: 'auto', available: false }) === ENGINE_STATUS.UNAVAILABLE);
  check('auto with AVPlay available says the browser is the first choice',
    c.status({ setting: 'auto', available: true }) === ENGINE_STATUS.BROWSER_FIRST);
  check('tv with AVPlay available is AVPlay active',
    c.status({ setting: 'tv', available: true }) === ENGINE_STATUS.ACTIVE);
  check('every status has a sentence',
    Object.values(ENGINE_STATUS).every((s) => describeEngine(s).length > 0));
}

// ── Content failures never count ─────────────────────────
{
  const c = createEngineController();
  for (let i = 0; i < 10; i += 1) {
    c.fail({ sceneId: i, level: 'content' });
  }
  check('ten content refusals do not disable AVPlay', !c.isDisabled());
  check('and the status stays browser-first',
    c.status({ setting: 'auto', available: true }) === ENGINE_STATUS.BROWSER_FIRST);
}

// ── Two engine failures on different scenes do ───────────
{
  const c = createEngineController();
  const first = c.fail({ sceneId: 1, level: 'engine' });
  check('one engine failure is not enough', first === false && !c.isDisabled());
  const second = c.fail({ sceneId: 2, level: 'engine' });
  check('the second, on another scene, trips the switch', second === true && c.isDisabled());
  check('the status reports the kill switch',
    c.status({ setting: 'auto', available: true }) === ENGINE_STATUS.KILL_SWITCH);
  check('and a later failure reports nothing new',
    c.fail({ sceneId: 3, level: 'engine' }) === false);
}

// ── The same scene twice is not two scenes ───────────────
{
  const c = createEngineController();
  c.fail({ sceneId: 7, level: 'engine' });
  c.fail({ sceneId: 7, level: 'engine' });
  check('two failures on one scene do not disable AVPlay', !c.isDisabled());
  c.fail({ sceneId: 8, level: 'engine' });
  check('a failure on a second scene does', c.isDisabled());
}

// ── A success clears the count ───────────────────────────
{
  const c = createEngineController();
  c.fail({ sceneId: 1, level: 'engine' });
  c.succeed();
  c.fail({ sceneId: 2, level: 'engine' });
  check('a success between failures clears the count', !c.isDisabled());
}

// ── The format cache ─────────────────────────────────────
{
  const c = createEngineController();
  check('nothing is blocked before a refusal', !c.blockedFormat(WMV));
  c.refusedDirect(WMV);
  check('a refused format is blocked', c.blockedFormat(WMV));
  check('the same format is blocked whatever the case',
    c.blockedFormat({ container: 'AVI', videoCodec: 'WMV2', audioCodec: 'WMAV2' }));
  check('another format is unaffected', !c.blockedFormat(H264));
  check('audio codec is part of the key', !c.blockedFormat(H264_PCM));
  c.refusedDirect(H264_PCM);
  check('and can be cached separately', c.blockedFormat(H264_PCM));
  check('the cache holds one key per format', c.refusedFormatKeys().length === 2);
}

// ── A refused format explains the next scene of it ───────
{
  const c = createEngineController();
  c.refusedDirect(WMV);
  check('a cached refusal is reported for the same format',
    c.status({ setting: 'auto', available: true, video: WMV })
    === ENGINE_STATUS.FORMAT_REFUSED);
  check('and not for another format',
    c.status({ setting: 'auto', available: true, video: H264 })
    === ENGINE_STATUS.BROWSER_FIRST);
  check('the kill switch outranks a format refusal',
    (() => {
      c.fail({ sceneId: 1, level: 'engine' });
      c.fail({ sceneId: 2, level: 'engine' });
      return c.status({ setting: 'auto', available: true, video: WMV })
        === ENGINE_STATUS.KILL_SWITCH;
    })());
  check('the setting outranks a format refusal',
    c.status({ setting: 'browser', available: true, video: WMV })
    === ENGINE_STATUS.BROWSER_SETTING);
  check('a missing scene has no format to blame',
    createEngineController().status({ setting: 'tv', available: true })
    === ENGINE_STATUS.ACTIVE);
}

// ── The browser cache mirrors it, separately ─────────────
{
  const c = createEngineController();
  check('nothing is blocked in the browser before a failure',
    !c.browserBlockedFormat(WMV));
  c.browserRefused(WMV);
  check('a browser refusal is remembered per format', c.browserBlockedFormat(WMV));
  check('and is case-insensitive like the AVPlay cache',
    c.browserBlockedFormat({ container: 'AVI', videoCodec: 'WMV2', audioCodec: 'WMAV2' }));
  check('it does not touch the AVPlay cache', !c.blockedFormat(WMV));
  check('nor does the AVPlay cache touch it',
    (() => {
      const d = createEngineController();
      d.refusedDirect(WMV);
      return !d.browserBlockedFormat(WMV);
    })());
  c.browserRefused(H264);
  check('formats are separate keys', c.browserRefusedFormatKeys().length === 2);
  check('unknown metadata caches nothing',
    (() => { const d = createEngineController(); d.browserRefused({}); return d.browserRefusedFormatKeys().length === 0; })());
}

// ── Unknown formats are never cached ─────────────────────
{
  const c = createEngineController();
  c.refusedDirect({});
  c.refusedDirect(null);
  check('a refusal with no codec information caches nothing',
    c.refusedFormatKeys().length === 0);
  check('and blocks no format', !c.blockedFormat({}));
}

// ── Controllers do not share state ───────────────────────
{
  const a = createEngineController();
  const b = createEngineController();
  a.refusedDirect(WMV);
  a.fail({ sceneId: 1, level: 'engine' });
  a.fail({ sceneId: 2, level: 'engine' });
  check('a second session starts with an empty cache', !b.blockedFormat(WMV));
  check('and AVPlay enabled', !b.isDisabled());
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
