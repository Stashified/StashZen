#!/usr/bin/env node
/**
 * test-seek-coalescer.mjs — rapid skims, last one wins, no lost distance
 *
 *   node scripts/test-seek-coalescer.mjs
 *
 * AVPlay has no seek-complete callback. The seeker therefore settles on a
 * position read, retries a seek that has not arrived, and degrades instead of
 * fighting forever. The acceptance criterion this file exists for: five rapid
 * +15 s presses must land 75 s ahead, not 15 s — which means each new request
 * must replace the pending target rather than queue behind it.
 *
 * The clock is injected, so "1.5 s passed" is a number assignment, not a
 * sleep. No framework.
 */

import {
  createSeekCoalescer,
  SEEK_SETTLE_MS,
  SEEK_SETTLE_HLS_MS,
  SEEK_MAX_RETRIES,
  SEEK_MAX_WAIT_MS,
} from '../src/utils/seekCoalescer.js';

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

function rig({ throwSeek = false, playing = true } = {}) {
  let now = 0;
  let pos = 0;
  const seeks = [];
  const degraded = [];
  const coalescer = createSeekCoalescer({
    seekTo(seconds) {
      if (throwSeek) throw new Error('seek refused');
      seeks.push(seconds);
    },
    getTime: () => pos,
    isPlaying: () => playing,
    now: () => now,
    onDegraded: (target) => degraded.push(target),
  });
  return {
    coalescer, seeks, degraded,
    advance(ms) { now += ms; },
    moveTo(seconds) { pos = seconds; },
    setPlaying(v) { playing = v; },
  };
}

// ── One seek, pending getter, settle ───────────────────────
{
  const r = rig();
  r.coalescer.request(10);
  check('request issues the seek immediately', eq(r.seeks, [10]));
  check('a pending seek is reported', r.coalescer.pendingTarget() === 10);
  check('isSeeking while in flight', r.coalescer.isSeeking() === true);

  r.moveTo(5);
  r.coalescer.tick();
  check('a position far from the target does not settle', r.coalescer.isSeeking() === true);

  r.moveTo(9);
  r.coalescer.tick();
  check('within tolerance settles', r.coalescer.isSeeking() === false);
  check('no pending target after settling', r.coalescer.pendingTarget() === null);
  check('settling issues no extra seek', eq(r.seeks, [10]));
  check('settling is not degradation', eq(r.degraded, []));
}

// ── A seek in flight must not settle while paused ──────────
{
  const r = rig({ playing: false });
  r.coalescer.request(30);
  r.moveTo(30);
  r.coalescer.tick();
  check('position reached but playback paused does not settle',
    r.coalescer.isSeeking() === true);
  r.setPlaying(true);
  r.coalescer.tick();
  check('resuming playback settles it', r.coalescer.isSeeking() === false);
}

// ── An arrived seek is extended, not restarted ─────────────
{
  // The HLS failure this pins: the position reaches the target while the
  // engine is still buffering, and re-issuing the seek every window cancels
  // the very work that was about to finish. On screen: "seek never finishes".
  const r = rig({ playing: false });
  r.coalescer.request(30);
  r.moveTo(30);
  r.advance(SEEK_SETTLE_MS);
  r.coalescer.tick();
  check('an arrived seek does not re-issue on the first window',
    eq(r.seeks, [30]));
  check('it is still pending while the engine buffers',
    r.coalescer.isSeeking() === true);

  r.advance(SEEK_SETTLE_MS);
  r.coalescer.tick();
  check('a second buffering window still does not restart the seek',
    eq(r.seeks, [30]));

  r.setPlaying(true);
  r.coalescer.tick();
  check('playback returning settles it', r.coalescer.isSeeking() === false);
  check('and it is not called degraded', r.coalescer.isDegraded() === false);
}

{
  // An engine that buffers forever is still bounded by the overall deadline,
  // so the panel ends up saying "degraded" rather than waiting for ever.
  const r = rig({ playing: false });
  r.coalescer.request(44);
  r.moveTo(44);
  for (let i = 0; r.coalescer.isSeeking() && i < 20; i++) {
    r.advance(SEEK_SETTLE_MS);
    r.coalescer.tick();
  }
  check('an arrived seek that never plays degrades in the end',
    eq(r.degraded, [44]));
  check('and never restarted the seek', eq(r.seeks, [44]));
}

// ── A frozen position is being worked on, not ignored ──────
{
  // The 4K AV1 case: the engine accepts the seek and needs seconds to decode
  // from the new keyframe. The position does not move in the meantime.
  const r = rig();
  r.coalescer.request(120);
  r.moveTo(0.1); // a stale sample, not movement
  r.advance(SEEK_SETTLE_MS * 4);
  r.coalescer.tick();
  check('a frozen position is not re-seeked', eq(r.seeks, [120]));
  check('and the seek is still considered in flight',
    r.coalescer.isSeeking() === true);

  for (let i = 0; r.coalescer.isSeeking() && i < 20; i++) {
    r.advance(SEEK_SETTLE_MS);
    r.coalescer.tick();
  }
  check('a seek that never moves degrades at the overall deadline',
    r.coalescer.isDegraded() === true);
  check('the overall deadline is what ended it',
    r.seeks.length === 1 && SEEK_MAX_WAIT_MS >= SEEK_SETTLE_MS * 2);
}

// ── Latest wins ────────────────────────────────────────────
{
  const r = rig();
  r.coalescer.request(15);
  r.coalescer.request(30);
  check('a newer target is issued, not queued', eq(r.seeks, [15, 30]));
  check('the pending target is the latest', r.coalescer.pendingTarget() === 30);

  r.moveTo(30);
  r.coalescer.tick();
  check('settles on the latest target', r.coalescer.isSeeking() === false);
}

{
  // Five rapid +15 s presses from 0, before any position read: the last target
  // must be 75, which is what "accumulate" means.
  const r = rig();
  for (let i = 1; i <= 5; i++) r.coalescer.request(i * 15);
  check('five rapid skims land on the fifth target', r.coalescer.pendingTarget() === 75);
  r.moveTo(75);
  r.coalescer.tick();
  check('the fifth target settles', r.coalescer.isSeeking() === false);
}

// ── Retry a seek playback ran past, then degrade ───────────
{
  const r = rig();
  r.coalescer.request(20);
  r.advance(SEEK_SETTLE_MS - 1);
  r.moveTo(1);
  r.coalescer.tick();
  check('before the window expires there is no retry', eq(r.seeks, [20]));

  r.advance(1);
  r.coalescer.tick();
  check('an expired window retries a seek playback ran past', eq(r.seeks, [20, 20]));

  // The engine is ignoring the request: the position keeps running.
  for (let i = 0; i < SEEK_MAX_RETRIES; i++) {
    r.moveTo(2 + i * 2);
    r.advance(SEEK_SETTLE_MS);
    r.coalescer.tick();
  }
  check('after the retry budget it degrades', eq(r.degraded, [20]));
  check('degraded is not seeking', r.coalescer.isSeeking() === false);
  check('degraded is reported', r.coalescer.isDegraded() === true);
  check('degrade fires once', r.degraded.length === 1);
}

{
  // A newer request clears the degraded flag — the next skim deserves its own
  // chance, and the UI must not keep saying "seek failed" forever.
  const r = rig();
  r.coalescer.request(5);
  for (let i = 0; i <= SEEK_MAX_RETRIES; i++) {
    r.moveTo(i + 1);
    r.advance(SEEK_SETTLE_MS);
    r.coalescer.tick();
  }
  check('rig settled into degraded', r.coalescer.isDegraded() === true);
  r.coalescer.request(40);
  check('a new request clears degraded', r.coalescer.isDegraded() === false);
  r.moveTo(40);
  r.coalescer.tick();
  check('and can settle normally', r.coalescer.isSeeking() === false);
}

// ── Throws degrade immediately (1 attempt + 2 retries) ──────
{
  const r = rig({ throwSeek: true });
  r.coalescer.request(12);
  check('three synchronous throws degrade', eq(r.degraded, [12]));
  check('a throwing seek leaves nothing pending', r.coalescer.pendingTarget() === null);
}

// ── Cancel ─────────────────────────────────────────────────
{
  const r = rig();
  r.coalescer.request(25);
  r.coalescer.cancel();
  check('cancel clears the pending seek', r.coalescer.pendingTarget() === null);
  check('cancel is not degradation', eq(r.degraded, []));
  r.advance(SEEK_SETTLE_MS * 3);
  r.coalescer.tick();
  check('a cancelled seek never fires on a later tick', eq(r.seeks, [25]));
}

// ── Input hygiene ──────────────────────────────────────────
{
  const r = rig();
  r.coalescer.request(-4);
  check('a negative target clamps to zero', eq(r.seeks, [0]));
  r.coalescer.request(NaN);
  r.coalescer.request('nope');
  check('non-finite targets are ignored', eq(r.seeks, [0]));
  check('ignored input did not disturb the pending seek', r.coalescer.pendingTarget() === 0);
}

// ── HLS gets the longer window ─────────────────────────────
{
  check('the HLS settle window is longer than the default',
    SEEK_SETTLE_HLS_MS > SEEK_SETTLE_MS);
  let now = 0;
  let pos = 0;
  const seeks = [];
  const c = createSeekCoalescer({
    seekTo: (s) => seeks.push(s),
    getTime: () => pos,
    now: () => now,
    settleMs: SEEK_SETTLE_HLS_MS,
  });
  c.request(100);
  pos = 2; // playback ran on: the request was ignored, not slow
  now = SEEK_SETTLE_MS + 1;
  c.tick();
  check('a 1.5 s wait is not enough for HLS', eq(seeks, [100]));
  now = SEEK_SETTLE_HLS_MS;
  c.tick();
  check('the HLS window retries later', eq(seeks, [100, 100]));
}

// ── The window can be decided per tick ─────────────────────
{
  // The AVPlay backend does not know its URL when the coalescer is built, so
  // it passes a function. A number captured at construction pinned HLS seeks
  // to the 1.5 s direct window — always one tick short of the measured 1.52 s.
  let now = 0;
  let pos = 0;
  let hls = true;
  const seeks = [];
  const c = createSeekCoalescer({
    seekTo: (s) => seeks.push(s),
    getTime: () => pos,
    now: () => now,
    settleMs: () => (hls ? SEEK_SETTLE_HLS_MS : SEEK_SETTLE_MS),
  });
  c.request(60);
  pos = 2;
  now = SEEK_SETTLE_MS + 1;
  c.tick();
  check('a function window gives HLS its longer deadline', eq(seeks, [60]));
  now = SEEK_SETTLE_HLS_MS;
  c.tick();
  check('and retries at that deadline', eq(seeks, [60, 60]));

  hls = false;
  pos = 4;
  c.request(10);
  pos = 6; // ignored again: playback ran past the request
  now += SEEK_SETTLE_MS;
  c.tick();
  check('the same coalescer uses the direct window once the source is direct',
    eq(seeks, [60, 60, 10, 10]));
}

// ── The overall deadline can be decided per source ─────────
{
  // The AVPlay backend gives direct play a shorter deadline than HLS: a direct
  // seek that has not landed is handed to the other engine, while a transcode
  // seek has nothing better to fall back to.
  const run = (wait, at) => {
    let now = 0;
    const degraded = [];
    const seeks = [];
    const c = createSeekCoalescer({
      seekTo: (s) => seeks.push(s),
      getTime: () => 0, // frozen: the engine is working, not ignoring us
      now: () => now,
      maxWaitMs: () => wait,
      onDegraded: (t) => degraded.push(t),
    });
    c.request(30);
    now = at;
    c.tick();
    return { degraded, seeking: c.isSeeking(), seeks };
  };
  const short = run(4000, 4000);
  check('a short per-source deadline ends a frozen seek', eq(short.degraded, [30]));
  check('and the burst is no longer pending', short.seeking === false);
  check('without re-issuing the seek that was working', eq(short.seeks, [30]));
  const long = run(8000, 4000);
  check('a long one keeps waiting at the same moment',
    long.degraded.length === 0 && long.seeking === true);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
