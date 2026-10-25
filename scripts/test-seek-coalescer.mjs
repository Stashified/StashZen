#!/usr/bin/env node
/**
 * test-seek-coalescer.mjs — rapid skims, last one wins, no lost distance
 *
 *   node scripts/test-seek-coalescer.mjs
 *
 * AVPlay has no seek-complete callback, so the seeker settles on a position
 * read, retries a seek that has not arrived, and degrades rather than fighting
 * forever. Five rapid +15 s presses must land 75 s ahead, not 15 s: each new
 * request replaces the pending target instead of queueing behind it. The clock
 * is injected, so "1.5 s passed" is a number assignment, not a sleep.
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
  const reasons = [];
  const coalescer = createSeekCoalescer({
    seekTo(seconds) {
      if (throwSeek) throw new Error('seek refused');
      seeks.push(seconds);
    },
    getTime: () => pos,
    isPlaying: () => playing,
    now: () => now,
    onDegraded: (target, reason) => {
      degraded.push(target);
      reasons.push(reason);
    },
  });
  return {
    coalescer, seeks, degraded, reasons,
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
  // The position reaches the target while the engine is still buffering;
  // re-issuing the seek every window cancels the work about to finish.
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
  // so the panel says "degraded" rather than waiting forever.
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
  check('the reason says the position arrived', eq(r.reasons, ['arrived']));
}

// ── A rapid burst that froze is re-issued once ─────────────
{
  // Overlapping seekTo calls leave the engine paused at the pre-burst
  // position: it lost the target, and one fresh request recovers the skim.
  // The single slow seek below must still never be restarted.
  const r = rig();
  r.coalescer.request(10);
  r.coalescer.request(25);           // overlapping: the burst did not settle
  r.moveTo(0);                       // frozen where the newest seek was issued
  r.advance(SEEK_SETTLE_MS);
  r.coalescer.tick();
  check('a frozen overlapped burst re-issues the final target once',
    eq(r.seeks, [10, 25, 25]));

  r.advance(SEEK_SETTLE_MS);
  r.coalescer.tick();
  check('it is re-issued only once', eq(r.seeks, [10, 25, 25]));

  r.advance(SEEK_MAX_WAIT_MS);
  r.coalescer.tick();
  check('the burst still ends at the overall deadline',
    eq(r.degraded, [25]) && eq(r.reasons, ['stuck']));
}

// ── A single frozen seek is never re-issued ────────────────
{
  // The control: one request is the engine scanning (a 4K AV1 seek takes
  // seconds), and restarting it is the "seek never finishes" failure.
  const r = rig();
  r.coalescer.request(120);
  r.moveTo(0);
  r.advance(SEEK_SETTLE_MS);
  r.coalescer.tick();
  r.advance(SEEK_SETTLE_MS);
  r.coalescer.tick();
  check('a single frozen seek is not re-issued', eq(r.seeks, [120]));
}

// ── Progress at the deadline extends it once ───────────────
{
  const r = rig();
  r.coalescer.request(30);
  r.moveTo(10);                      // closing the gap, not at the target
  r.advance(SEEK_MAX_WAIT_MS);
  r.coalescer.tick();
  check('a seek still closing the gap past the deadline is not failed',
    eq(r.degraded, []) && r.coalescer.isSeeking() === true);

  r.advance(SEEK_MAX_WAIT_MS);
  r.coalescer.tick();
  check('the extended deadline ends it, with its own reason',
    eq(r.degraded, [30]) && eq(r.reasons, ['progress']));
  check('and it never restarted the seek', eq(r.seeks, [30]));
}

// ── A frozen position is being worked on, not ignored ──────
{
  // The 4K AV1 case: the engine accepts the seek and needs seconds to decode
  // from the new keyframe, so the position does not move.
  const r = rig();
  r.coalescer.request(120);
  r.moveTo(0.1); // a stale sample, not movement
  r.advance(SEEK_SETTLE_MS * 2); // inside the overall deadline
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
  // must be 75.
  const r = rig();
  for (let i = 1; i <= 5; i++) r.coalescer.request(i * 15);
  check('five rapid skims land on the fifth target', r.coalescer.pendingTarget() === 75);
  r.moveTo(75);
  r.coalescer.tick();
  check('the fifth target settles', r.coalescer.isSeeking() === false);
}

// ── Forward progress is not an ignored seek ────────────────
{
  // A forward seek plays on while the engine scans: the position moves and the
  // distance shrinks. Treating that as "ignored" and re-issuing aborted a seek
  // about to land, handing rapid HEVC skims to the browser.
  const r = rig();
  r.coalescer.request(20);
  r.advance(SEEK_SETTLE_MS);
  r.moveTo(3);
  r.coalescer.tick();
  check('a forward seek that is closing the gap is not re-issued',
    eq(r.seeks, [20]));

  r.advance(SEEK_SETTLE_MS);
  r.moveTo(6);
  r.coalescer.tick();
  check('the window keeps sliding while the seek makes progress',
    eq(r.seeks, [20]));
  check('a progressing seek stays in flight', r.coalescer.isSeeking() === true);

  r.moveTo(19);
  r.coalescer.tick();
  check('the progressing seek settles at its target',
    r.coalescer.isSeeking() === false);
  check('progress is never called degradation', eq(r.degraded, []));
}

// ── Retry a seek playback ran *away* from, then degrade ────
{
  // Backward skim from 50 to 20: playback continuing forward runs away from
  // the target, which is the only movement that says the request was ignored.
  const r = rig();
  r.moveTo(50);
  r.coalescer.request(20);
  r.advance(SEEK_SETTLE_MS - 1);
  r.moveTo(51);
  r.coalescer.tick();
  check('before the window expires there is no retry', eq(r.seeks, [20]));

  r.advance(1);
  r.coalescer.tick();
  check('an expired window retries a seek playback ran past', eq(r.seeks, [20, 20]));

  // The engine ignores the request; the position keeps running forward.
  for (let i = 0; i < SEEK_MAX_RETRIES; i++) {
    r.moveTo(53 + i * 2);
    r.advance(SEEK_SETTLE_MS);
    r.coalescer.tick();
  }
  check('after the retry budget it degrades', eq(r.degraded, [20]));
  check('degraded is not seeking', r.coalescer.isSeeking() === false);
  check('degraded is reported', r.coalescer.isDegraded() === true);
  check('degrade fires once', r.degraded.length === 1);
}

{
  // A newer request clears the degraded flag so the UI does not keep saying
  // "seek failed" forever.
  const r = rig();
  r.moveTo(50);
  r.coalescer.request(5);
  for (let i = 0; i <= SEEK_MAX_RETRIES; i++) {
    r.moveTo(51 + i * 2);
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

// ── HLS gets its own window ────────────────────────────────
{
  // Measured: an HLS seek settled in 1.52 s, a direct HEVC seek in 2–3 s. The
  // windows are per source because the two engines are not the same speed.
  check('the HLS window is its own, not the direct default',
    SEEK_SETTLE_HLS_MS !== SEEK_SETTLE_MS);
  let now = 0;
  let pos = 50;
  const seeks = [];
  const c = createSeekCoalescer({
    seekTo: (s) => seeks.push(s),
    getTime: () => pos,
    now: () => now,
    settleMs: SEEK_SETTLE_HLS_MS,
  });
  c.request(10);
  pos = 52; // playback ran on away from a backward target: ignored, not slow
  now = SEEK_SETTLE_HLS_MS - 1;
  c.tick();
  check('the HLS window has not expired yet', eq(seeks, [10]));
  now = SEEK_SETTLE_HLS_MS;
  c.tick();
  check('the HLS window retries at its own deadline', eq(seeks, [10, 10]));
}

// ── The window can be decided per tick ─────────────────────
{
  // The AVPlay backend does not know its source when the coalescer is built,
  // so it passes a function. A number captured at construction pinned every
  // seek to one engine's window.
  let now = 0;
  let pos = 50;
  let hls = true;
  const seeks = [];
  const c = createSeekCoalescer({
    seekTo: (s) => seeks.push(s),
    getTime: () => pos,
    now: () => now,
    settleMs: () => (hls ? SEEK_SETTLE_HLS_MS : SEEK_SETTLE_MS),
  });
  c.request(10);
  pos = 52;
  now = SEEK_SETTLE_HLS_MS - 1;
  c.tick();
  check('a function window gives HLS its own deadline', eq(seeks, [10]));
  now = SEEK_SETTLE_HLS_MS;
  c.tick();
  check('and retries at that deadline', eq(seeks, [10, 10]));

  hls = false;
  pos = 50;
  c.request(20);
  pos = 52; // ignored again: playback ran away from the target
  now += SEEK_SETTLE_MS - 1;
  c.tick();
  check('the direct window has not expired yet', eq(seeks, [10, 10, 20]));
  now += 1;
  c.tick();
  check('the same coalescer uses the direct window once the source is direct',
    eq(seeks, [10, 10, 20, 20]));
}

// ── The overall deadline can be decided per source ─────────
{
  // The deadline is an option, not a constant, so the backend can tune it per
  // source. It uses 8 s for both: a direct HEVC seek measured 2–3 s, and
  // failing one early is what sent scenes to the browser.
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

// ── The deadline is not debounced by the settle window ─────
{
  // The window's reset used to gate the deadline check, so a 4 s deadline
  // first fired on the next window boundary — up to 3 s later.
  let now = 0;
  const reasons = [];
  const c = createSeekCoalescer({
    seekTo: () => {},
    getTime: () => 30, // arrived…
    isPlaying: () => false, // …but the engine never resumed
    now: () => now,
    maxWaitMs: 4000,
    onDegraded: (t, reason) => reasons.push(reason),
  });
  c.request(30);
  now = SEEK_SETTLE_MS;
  c.tick();
  check('no verdict when the settle window ends before the deadline',
    eq(reasons, []));
  now = 4000;
  c.tick();
  check('the deadline alone ends the burst, without waiting for another window',
    eq(reasons, ['arrived']));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
