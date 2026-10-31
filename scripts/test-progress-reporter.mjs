#!/usr/bin/env node
/**
 * test-progress-reporter.mjs: what the player writes back to Stash
 *
 *   node scripts/test-progress-reporter.mjs
 *
 * The reporter can write permanently wrong data: `play_duration` is added
 * server-side, so a delta sent twice, a position read after a source swap, or a
 * queued save that re-reads live values all corrupt the library rather than
 * misdrawing a screen. The DOM sweep covers the player, but timing-dependent
 * cases are easier to hold still here with the network calls as controllable
 * promises.
 */

import { createProgressReporter } from '../src/components/player/progressReporter.js';

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

// Watch time is summed from float deltas, so 0.6 + 0.6 is not 1.2. Compare
// with a tolerance rather than pinning the arithmetic.
const approx = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// A reporter whose writes never settle until the test says so, logging
// everything it was asked to do.
function rig({ playOk = true, playError = 'play failed' } = {}) {
  const writes = [];
  const pending = [];
  const plays = [];
  const sync = [];
  const completed = [];
  const reporter = createProgressReporter({
    save: (input) => {
      writes.push(input);
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    addPlay: (id) => {
      plays.push(id);
      return Promise.resolve(playOk ? { ok: true } : { ok: false, error: { message: playError } });
    },
    onSync: (state) => sync.push(state),
    onCompleted: (id) => completed.push(id),
  });
  return { reporter, writes, pending, plays, sync, completed };
}

// ── Credit: only playback counts ───────────────────────────
{
  const { reporter, writes } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.tick(10, false);    // the first tick has no predecessor to bill
  reporter.tick(10.5, false);  // 0.5s of playback
  reporter.tick(11, true);     // paused: the clock moved, but not by watching
  reporter.tick(30, false);    // a skim-sized step
  reporter.tick(20, false);    // backwards
  reporter.save('1');

  check('a save carries the last position', writes[0]?.resumeTime === 20,
    JSON.stringify(writes[0]));
  check('only playback-credit time is reported', writes[0]?.playDuration === 0.5,
    JSON.stringify(writes[0]));
  check('paused ticks, seek-sized steps and backwards steps are not credited',
    writes[0]?.playDuration === 0.5, JSON.stringify(writes[0]));
}

// ── Nothing to report ──────────────────────────────────────
{
  const { reporter, writes, pending } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.tick(10, false);
  reporter.tick(10.5, false);
  reporter.save('1');
  pending[0].resolve({ ok: true });
  await flush();

  reporter.tick(10.9, false);  // 0.4s: below PLAY_CREDIT_MIN_S
  reporter.save('1');
  check('a save with no movement and no worth-while watch time is skipped',
    writes.length === 1, `writes ${JSON.stringify(writes)}`);

  reporter.tick(11.9, false);  // one whole second of playback
  reporter.save('1');
  check('one whole second of watch time is worth a request',
    writes.length === 2, `writes ${JSON.stringify(writes)}`);
}

// ── One write at a time; latest wins ───────────────────────
{
  const { reporter, writes, pending } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.tick(10, false);
  reporter.tick(10.5, false);
  reporter.save('1');
  reporter.seek(25);
  reporter.save('1');

  check('a second save is queued while one is in flight', writes.length === 1,
    JSON.stringify(writes));

  pending[0].resolve({ ok: true });
  await flush();
  check('the queued save is sent after the first settles', writes.length === 2,
    JSON.stringify(writes));
  check('the queued save is the latest snapshot, not the first',
    eq(writes[1], { id: '1', resumeTime: 25, playDuration: 0 }), JSON.stringify(writes[1]));
}

// ── A failure keeps what is owed; a success subtracts exactly what it sent ──
{
  const { reporter, writes, pending, sync } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.tick(10, false);
  reporter.tick(10.6, false);  // 0.6
  reporter.tick(11.2, false);  // 0.6 → 1.2 owed
  reporter.save('1');
  check('the first save carries the accrued watch time',
    approx(writes[0]?.playDuration, 1.2), JSON.stringify(writes[0]));

  pending[0].resolve({ ok: false, error: { message: 'simulated save failure' } });
  await flush();
  check('a failed save is reported', sync.includes('failed'), JSON.stringify(sync));

  reporter.seek(14);
  reporter.tick(14.5, false);  // +0.5 → 1.7 owed
  reporter.save('1');
  check('a failed save leaves the owed watch time in place',
    approx(writes[1]?.playDuration, 1.7), JSON.stringify(writes[1]));
  check('it also retries the position', writes[1]?.resumeTime === 14.5,
    JSON.stringify(writes[1]));

  pending[1].resolve({ ok: true });
  await flush();
  // One and a half seconds, so both halves of the skip rule let it through:
  // the position moved more than 2 s and there is enough watch time to report.
  reporter.seek(16);
  reporter.tick(16.5, false);  // +0.5
  reporter.tick(17.5, false);  // +1.0 → 1.5
  reporter.save('1');
  check('a landed save subtracts only what it sent',
    approx(writes[2]?.playDuration, 1.5), JSON.stringify(writes[2]));
}

// ── A rejected write must not wedge the sender ─────────────
{
  const writes = [];
  const pending = [];
  const sync = [];
  let calls = 0;
  const reporter = createProgressReporter({
    save: (input) => {
      writes.push(input);
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('socket closed'));
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    addPlay: () => Promise.resolve({ ok: true }),
    onSync: (state) => sync.push(state),
  });
  reporter.setScene('1');
  reporter.resetScene();
  reporter.seek(5);
  reporter.save('1');
  await flush();

  check('a rejected save goes through the failure chip',
    sync.includes('failed') && reporter.syncError()?.message === 'socket closed',
    JSON.stringify(sync));

  reporter.seek(6);
  reporter.save('1');
  check('a rejected save does not wedge later saves', writes.length === 2,
    `writes ${JSON.stringify(writes)}`);
  pending[0].resolve({ ok: true });
  await flush();
}

{
  const writes = [];
  const first = deferred();
  let calls = 0;
  const reporter = createProgressReporter({
    save: (input) => {
      writes.push(input);
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve({ ok: true });
    },
    addPlay: () => Promise.resolve({ ok: true }),
    onSync: () => {},
  });
  reporter.setScene('1');
  reporter.resetScene();
  reporter.seek(5);
  reporter.save('1');
  reporter.seek(9);
  reporter.save('1');   // queued behind the first
  check('the queued save waits for the first to settle', writes.length === 1,
    JSON.stringify(writes));

  first.reject(new Error('timed out'));
  await flush();
  check('a rejection drains the queued snapshot', writes.length === 2,
    JSON.stringify(writes));
  check('the queued snapshot keeps its own position', writes[1]?.resumeTime === 9,
    JSON.stringify(writes[1]));
}

{
  let saves = 0;
  const sync = [];
  const reporter = createProgressReporter({
    save: () => { saves += 1; return Promise.resolve(undefined); },
    addPlay: () => Promise.resolve({ ok: true }),
    onSync: (state) => sync.push(state),
  });
  reporter.setScene('1');
  reporter.resetScene();
  reporter.seek(5);
  reporter.save('1');
  await flush();
  check('a save resolving to nothing is a failure, not a success',
    sync.includes('failed'), JSON.stringify(sync));

  reporter.seek(6);
  reporter.save('1');
  await flush();
  check('and it does not wedge the next save', saves === 2, String(saves));
}

{
  const sync = [];
  const reporter = createProgressReporter({
    save: () => { throw new Error('sync boom'); },
    addPlay: () => Promise.resolve({ ok: true }),
    onSync: (state) => sync.push(state),
  });
  reporter.setScene('1');
  reporter.resetScene();
  reporter.seek(5);
  reporter.save('1');
  await flush();
  check('a synchronous throw from save is reported, not thrown at the caller',
    sync.includes('failed') && reporter.syncError()?.message === 'sync boom',
    JSON.stringify(sync));
}

// ── A late response must not touch the new scene ───────────
{
  const { reporter, writes, pending, completed } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.seek(12);
  reporter.save('1');

  // The queue advances while scene 1's write is in flight.
  reporter.setScene('2');
  reporter.resetScene();
  reporter.tick(0, false);
  reporter.tick(0.4, false);   // 0.4 owed for scene 2
  reporter.seek(11.5);

  pending[0].resolve({ ok: true });  // scene 1's late success
  await flush();

  reporter.save('2');
  check('a late success for the previous scene does not stamp its position '
    + 'over the new one', writes.length === 2, JSON.stringify(writes));
  check('the new scene keeps its own position',
    writes[1]?.resumeTime === 11.5, JSON.stringify(writes[1]));
  check('the late success drains no watch time from the new scene',
    writes[1]?.playDuration === 0.4, JSON.stringify(writes[1]));
  check('it also cannot complete the new scene',
    completed.length === 0, JSON.stringify(completed));
}

// ── Completion and replay ──────────────────────────────────
{
  const { reporter, writes, pending, completed } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.tick(10, false);
  reporter.tick(10.6, false);
  reporter.tick(11.2, false);  // 1.2s owed: above PLAY_CREDIT_MIN_S
  reporter.complete();
  reporter.save('1');

  check('a completed scene reports position 0', writes[0]?.resumeTime === 0,
    JSON.stringify(writes[0]));
  // `completed` is a local latch, not a field of the write: Stash expresses
  // "watched to the end" as position 0, and the shelf prune is the caller's.
  check('the write carries only the position and the watch time',
    eq(Object.keys(writes[0]).sort(), ['id', 'playDuration', 'resumeTime']),
    JSON.stringify(writes[0]));

  pending[0].resolve({ ok: true });
  await flush();
  check('only a landed completion prunes the shelf card',
    eq(completed, ['1']), JSON.stringify(completed));

  reporter.reopen();
  reporter.seek(5);
  reporter.tick(5.5, false);
  reporter.save('1');
  check('a replay reports its position again', writes[1]?.resumeTime === 5.5,
    JSON.stringify(writes[1]));
  pending[1].resolve({ ok: true });
  await flush();
  check('a replay is not reported as a completion',
    eq(completed, ['1']), JSON.stringify(completed));
}

// ── A completion outlives the scene it belongs to ──────────
{
  const { reporter, writes, pending, completed } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.tick(10, false);
  reporter.tick(11.5, false);  // 1.5 s owed
  reporter.complete();
  reporter.save('1');

  // `ended` calls save() and then goNext(); the queue has moved on by the
  // time the write lands. The prune still names scene 1.
  reporter.setScene('2');
  reporter.resetScene();
  pending[0].resolve({ ok: true });
  await flush();

  check('a completion that lands after a queue advance still prunes its card',
    eq(completed, ['1']), JSON.stringify(completed));
  check('the late completion does not write anything for the new scene',
    writes.length === 1, JSON.stringify(writes));
}

{
  const reporterRig = rig();
  const { reporter, pending, completed } = reporterRig;
  reporter.setScene('1');
  reporter.resetScene();
  reporter.tick(10, false);
  reporter.tick(11.5, false);
  reporter.complete();
  reporter.save('1');
  // Back-to-close disposes the reporter before the write settles. The shelf
  // under the closed player is still there to be pruned.
  reporter.dispose();
  pending[0].resolve({ ok: true });
  await flush();
  check('a completion that lands after the player closed still prunes its card',
    eq(completed, ['1']), JSON.stringify(completed));

  const failedRig = rig();
  failedRig.reporter.setScene('1');
  failedRig.reporter.resetScene();
  failedRig.reporter.tick(10, false);
  failedRig.reporter.tick(11.5, false);
  failedRig.reporter.complete();
  failedRig.reporter.save('1');
  failedRig.pending[0].resolve({ ok: false, error: { message: 'nope' } });
  await flush();
  check('a completion the server rejected does not prune the card',
    failedRig.completed.length === 0, JSON.stringify(failedRig.completed));
}

// ── The play counter ───────────────────────────────────────
{
  const { reporter, plays, sync } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.countPlay('1');
  reporter.countPlay('1');
  check('a scene is counted once', plays.length === 1, JSON.stringify(plays));

  reporter.countPlay('2');
  check('the next scene is counted too', eq(plays, ['1', '2']), JSON.stringify(plays));

  reporter.setScene('1');
  reporter.resetScene();
  reporter.countPlay('1');
  check('a scene revisited in the same session is not counted again',
    plays.length === 2, JSON.stringify(plays));

  reporter.countPlay(null);
  check('no scene id means no request', plays.length === 2, JSON.stringify(plays));
  check('a successful count says nothing on the chip', sync.length === 0,
    JSON.stringify(sync));
}

{
  const { reporter, sync } = rig({ playOk: false });
  reporter.countPlay('1');
  await flush();
  check('a failed play count goes through the same chip',
    sync.includes('failed') && reporter.syncError()?.message === 'play failed',
    JSON.stringify(sync));
}

// ── Reads and unmount ──────────────────────────────────────
{
  const { reporter, sync } = rig();
  reporter.reportError({ message: 'read failed' });
  check('a failed read is reported too',
    sync.includes('failed') && reporter.syncError()?.message === 'read failed',
    JSON.stringify(sync));
}

{
  const { reporter, writes, pending, sync } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.seek(5);
  reporter.save('1');
  reporter.dispose();
  pending[0].resolve({ ok: true });
  await flush();
  check('an unmounted reporter does not paint the chip',
    !sync.includes('saved') && writes.length === 1, JSON.stringify(sync));
}

// ── resetScene clears the scene, not the session ───────────
{
  const { reporter, writes, plays } = rig();
  reporter.setScene('1');
  reporter.resetScene();
  reporter.countPlay('1');
  reporter.complete();
  reporter.resetScene();
  reporter.seek(3);
  reporter.save('1');
  check('resetScene clears the completion latch', writes[0]?.resumeTime === 3,
    JSON.stringify(writes[0]));
  reporter.countPlay('1');
  check('resetScene does not re-arm the play counter',
    plays.length === 1, JSON.stringify(plays));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
