#!/usr/bin/env node
/**
 * test-engine-policy.mjs — the playback engine decision, without a TV
 *
 *   node scripts/test-engine-policy.mjs
 *
 * These rules decide whether a scene is handed to AVPlay, the browser, or a
 * transcode, and in what order. A mistake here is not a cosmetic one: a static
 * deny list would send WMV to the transcoder on an older panel that can decode
 * it natively, and dropping the browser candidate entirely would break the one
 * measured scene (22546, H.264 + pcm_s32le) that only the browser plays.
 *
 * No framework, same as test-play-queue.mjs.
 */

import {
  PLAYBACK_ENGINES,
  readPlaybackEngine,
  canUseAvplay,
  needsTranscodeForEngine,
  avplayLikelyDirect,
  preferBrowserDirect,
  buildCandidatePlan,
  sourceKey,
  createEngineHealth,
} from '../src/utils/enginePolicy.js';

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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kinds = (plan) => plan.map((c) => `${c.engine}:${c.kind}`);

const H264 = { videoCodec: 'h264', audioCodec: 'aac', container: 'mp4' };
const WMV = { videoCodec: 'wmv2', audioCodec: 'wmav2', container: 'wmv' };
const PCM = { videoCodec: 'h264', audioCodec: 'pcm_s32le', container: 'mp4' };
// Scene 24844: MPEG-TS, H.264/AAC. The app's browser allowlist counts mpegts
// as direct, so `Auto` gives it to the browser first — the one AVPlay-only file
// in this library that is *not* pre-empted. Kept as a named case because it is
// the file the TV pass uses for the silent-refusal watchdog.
const MPEGTS = { videoCodec: 'h264', audioCodec: 'aac', container: 'mpegts' };

// ── The persisted vocabulary ────────────────────────────────
check('PLAYBACK_ENGINES is auto, tv, browser', eq(PLAYBACK_ENGINES, ['auto', 'tv', 'browser']));
check('readPlaybackEngine: browser is kept', readPlaybackEngine('browser') === 'browser');
check('readPlaybackEngine: tv is kept', readPlaybackEngine('tv') === 'tv');
check('readPlaybackEngine: auto is kept', readPlaybackEngine('auto') === 'auto');
check('readPlaybackEngine: absent means auto', readPlaybackEngine(undefined) === 'auto');
check('readPlaybackEngine: garbage means auto', readPlaybackEngine('AVPlay') === 'auto');

// ── canUseAvplay ────────────────────────────────────────────
check('canUseAvplay: auto + available', canUseAvplay({ setting: 'auto', available: true }) === true);
check('canUseAvplay: tv + available', canUseAvplay({ setting: 'tv', available: true }) === true);
check('canUseAvplay: browser setting wins', canUseAvplay({ setting: 'browser', available: true }) === false);
check('canUseAvplay: unavailable engine', canUseAvplay({ setting: 'auto', available: false }) === false);
check('canUseAvplay: build-level forced browser', canUseAvplay({ setting: 'auto', available: true, forcedBrowser: true }) === false);

// ── needsTranscodeForEngine ─────────────────────────────────
check('needsTranscodeForEngine: AVPlay never pre-empts WMV', needsTranscodeForEngine(WMV, 'avplay') === false);
check('needsTranscodeForEngine: AVPlay never pre-empts H.264', needsTranscodeForEngine(H264, 'avplay') === false);
check('needsTranscodeForEngine: browser still pre-empts WMV', needsTranscodeForEngine(WMV, 'html5') === true);
check('needsTranscodeForEngine: browser leaves H.264 direct', needsTranscodeForEngine(H264, 'html5') === false);

// ── Format hints (informational only) ───────────────────────
check('avplayLikelyDirect: H.264 MP4', avplayLikelyDirect(H264) === true);
check('avplayLikelyDirect: WMV is not expected', avplayLikelyDirect(WMV) === false);
check('avplayLikelyDirect: unknown metadata is not a verdict', avplayLikelyDirect({}) === true);
check('avplayLikelyDirect: unknown video codec is not expected', avplayLikelyDirect({ videoCodec: 'theora' }) === false);
check('preferBrowserDirect: pcm_s32le is browser-first', preferBrowserDirect(PCM) === true);
check('preferBrowserDirect: case and space tolerated', preferBrowserDirect({ audioCodec: ' PCM_S32LE ' }) === true);
check('preferBrowserDirect: aac is not', preferBrowserDirect(H264) === false);

// ── Browser setting: exactly today's plan ───────────────────
{
  const plan = buildCandidatePlan({ video: H264, setting: 'browser', available: true });
  check('browser plan: H.264 is direct then transcode',
    eq(kinds(plan), ['html5:direct', 'html5:transcode']), kinds(plan));
}
{
  const plan = buildCandidatePlan({ video: WMV, setting: 'browser', available: true });
  check('browser plan: WMV is transcode then direct',
    eq(kinds(plan), ['html5:transcode', 'html5:direct']), kinds(plan));
}
{
  const plan = buildCandidatePlan({ video: WMV, setting: 'auto', available: false });
  check('auto without AVPlay is the browser plan',
    eq(kinds(plan), ['html5:transcode', 'html5:direct']), kinds(plan));
}
{
  const plan = buildCandidatePlan({ video: H264, setting: 'auto', available: true, forcedBrowser: true });
  check('forced browser is the browser plan',
    eq(kinds(plan), ['html5:direct', 'html5:transcode']), kinds(plan));
}

// ── Auto with AVPlay: browser first, try do not deny ────────
{
  const plan = buildCandidatePlan({ video: H264, setting: 'auto', available: true });
  check('auto plan: the browser is first, AVPlay immediately after',
    eq(kinds(plan), ['html5:direct', 'avplay:direct', 'html5:transcode', 'avplay:transcode']),
    kinds(plan));
}
{
  const plan = buildCandidatePlan({ video: MPEGTS, setting: 'auto', available: true });
  check('auto plan: an mpegts file the classifier calls direct goes to the browser first',
    eq(kinds(plan), ['html5:direct', 'avplay:direct', 'html5:transcode', 'avplay:transcode']),
    kinds(plan));
}
{
  const plan = buildCandidatePlan({ video: WMV, setting: 'auto', available: true });
  check('auto plan: a browser-refused format goes to AVPlay first',
    eq(kinds(plan), ['avplay:direct', 'avplay:transcode', 'html5:transcode', 'html5:direct']),
    kinds(plan));
}
{
  const plan = buildCandidatePlan({ video: PCM, setting: 'auto', available: true });
  check('auto plan: pcm_s32le is browser-direct first',
    eq(kinds(plan), ['html5:direct', 'avplay:direct', 'html5:transcode', 'avplay:transcode']),
    kinds(plan));
}
{
  const plan = buildCandidatePlan({ video: H264, setting: 'auto', available: true });
  check('auto plan: every candidate is a fresh descriptor',
    plan.every((c) => Object.keys(c).sort().join(',') === 'engine,kind'));
}

// ── TV setting: AVPlay first, the measured exception ────────
{
  const plan = buildCandidatePlan({ video: H264, setting: 'tv', available: true });
  check('tv plan: AVPlay direct first',
    eq(kinds(plan), ['avplay:direct', 'html5:direct', 'avplay:transcode', 'html5:transcode']),
    kinds(plan));
}
{
  const plan = buildCandidatePlan({ video: WMV, setting: 'tv', available: true });
  check('tv plan: a browser-refused format is AVPlay direct first',
    eq(kinds(plan), ['avplay:direct', 'avplay:transcode', 'html5:transcode', 'html5:direct']),
    kinds(plan));
}
{
  const plan = buildCandidatePlan({ video: PCM, setting: 'tv', available: true });
  check('tv plan: pcm_s32le keeps the measured browser-first exception',
    eq(kinds(plan), ['html5:direct', 'avplay:direct', 'html5:transcode', 'avplay:transcode']),
    kinds(plan));
}

// ── sourceKey ───────────────────────────────────────────────
check('sourceKey: same URL, different engine is a different key',
  sourceKey('avplay', 'http://x/a.mp4') !== sourceKey('html5', 'http://x/a.mp4'));
check('sourceKey: same engine is stable',
  sourceKey('html5', 'http://x/a.mp4') === sourceKey('html5', 'http://x/a.mp4'));
check('sourceKey: empty is representable', sourceKey(null, '') === 'none:');

// ── Session kill switch ─────────────────────────────────────
{
  const h = createEngineHealth({ limit: 2 });
  check('health: starts enabled', h.disabled() === false);
  check('health: one scene is not a verdict', h.fail('1', 'prepare failed') === false && h.disabled() === false);
  check('health: the same scene twice is still one scene',
    h.fail('1', 'prepare failed again') === false && h.disabled() === false);
  check('health: a second scene disables and reports the transition',
    h.fail('2', 'open threw') === true && h.disabled() === true);
  check('health: the reason is kept', h.reason() === 'open threw');
  check('health: later failures do not re-report', h.fail('3', 'later') === false);
  h.succeed();
  check('health: success does not resurrect a disabled engine', h.disabled() === true);
}
{
  const h = createEngineHealth({ limit: 2 });
  h.fail('1');
  h.succeed();
  check('health: success clears the scene count',
    h.fail('2') === false && h.disabled() === false);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
