#!/usr/bin/env node
/**
 * test-avplay-backend.mjs: the AVPlay adapter's contract, off-device.
 *
 *   node scripts/test-avplay-backend.mjs
 *
 * The fake implements only the calls the probe measured and the backend makes.
 * This pins what the TV would otherwise have to report on every run:
 *
 *   - the event order the player's hooks expect (metadata → play → playing)
 *   - the error contract (`.error` set *before* `error`, a refused codec
 *     classified as content, not a broken engine)
 *   - the seek contract (coalescer targets and the pending-target getter)
 *   - suspend/restore, including the no-args restore this panel insists on
 *   - the poll's lifecycle: it stops on failure or scene end, replay re-arms it
 *   - TV mute and its restore-on-close rule
 */

import { createAvplayBackend } from '../src/components/player/engine/avplayBackend.js';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── A minimal truthful fake ────────────────────────────────
function fakeAvplay({
  failPrepare = false, prepareMs = 5, stuckSeeks = 0, failRecoveryPrepares = 0,
} = {}) {
  let state = 'IDLE';
  let position = 0;
  let durationMs = 600000;
  const calls = {
    open: [], close: 0, stop: 0, play: 0, pause: 0, seek: [],
    suspend: 0, restore: [], displayMethod: [], displayRect: [],
    // Poll reads; the lifecycle tests prove the poll stopped, not just that it
    // stopped emitting.
    state: 0,
  };
  let listener = null;
  const api = {
    open(url) { calls.open.push(url); state = 'OPENED'; position = 0; },
    setListener(l) { listener = l; },
    setDisplayRect(...a) { calls.displayRect.push(a); },
    setDisplayMethod(m) { calls.displayMethod.push(m); },
    prepareAsync(ok, bad) {
      state = 'PREPARING';
      // An open after the first is a recovery reopen.
      const recoveryOpen = calls.open.length > 1;
      setTimeout(() => {
        if (recoveryOpen && failRecoveryPrepares > 0) {
          failRecoveryPrepares -= 1;
          state = 'IDLE';
          bad({ name: 'PLAYER_ERROR_CONNECTION_FAILED', message: 'reopen refused' });
        } else if (failPrepare) {
          state = 'IDLE';
          bad({ name: 'PLAYER_ERROR_CONNECTION_FAILED', message: 'codec refused' });
        } else {
          state = 'READY';
          ok();
        }
      }, prepareMs);
    },
    play() { calls.play += 1; if (state === 'READY' || state === 'PAUSED') state = 'PLAYING'; },
    pause() { calls.pause += 1; if (state === 'PLAYING') state = 'PAUSED'; },
    stop() { calls.stop += 1; state = 'IDLE'; },
    close() { calls.close += 1; state = 'IDLE'; },
    seekTo(ms, ok) {
      calls.seek.push(ms);
      // The first N seeks are accepted and never land, the shape of a 4K seek
      // the decoder cannot finish.
      if (stuckSeeks > 0) stuckSeeks -= 1;
      else position = ms;
      setTimeout(() => ok?.(), 0);
    },
    suspend() { calls.suspend += 1; if (state === 'PLAYING') state = 'SUSPENDED'; },
    restore(...args) {
      calls.restore.push(args);
      if (args.length) throw new TypeError('restore() takes no arguments');
      if (state === 'SUSPENDED') state = 'PLAYING';
    },
    getState: () => { calls.state += 1; return state; },
    getCurrentTime: () => position,
    getDuration: () => durationMs,
  };
  return {
    api,
    calls,
    fireError: (raw) => listener?.onerror?.(raw),
    setStuckSeeks: (n) => { stuckSeeks = n; },
    complete: () => listener?.onstreamcompleted(),
    setPosition: (ms) => { position = ms; },
    setDuration: (ms) => { durationMs = ms; },
    setState: (s) => { state = s; },
  };
}

function fakeDoc() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type, ...args) { listeners.get(type)?.forEach((fn) => fn(...args)); },
    count(type) { return listeners.get(type)?.size || 0; },
  };
}

function fakeWin() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type, ...args) { listeners.get(type)?.forEach((fn) => fn(...args)); },
    count(type) { return listeners.get(type)?.size || 0; },
  };
}

function rig(opts = {}, backendOpts = {}) {
  const fake = fakeAvplay(opts);
  const events = [];
  const doc = fakeDoc();
  const win = fakeWin();
  let backend = null;
  const emit = (type) => {
    events.push(type);
    // The error contract: `.error` must already be readable when the event
    // arrives, or usePlayerMedia's guard drops it.
    if (type === 'error') events.push(backend.error ? 'error:set' : 'error:unset');
  };
  backend = createAvplayBackend({ avplay: fake.api, emit, doc, win, ...backendOpts });
  return { fake, events, doc, win, backend };
}

// ── Open → metadata → play → playing ──────────────────────
{
  const r = rig();
  r.backend.open('http://x/scene/1/stream.m3u8?apikey=k', { autoplay: true });
  check('open passes the URL to AVPlay', eq(r.fake.calls.open, ['http://x/scene/1/stream.m3u8?apikey=k']));
  check('letterbox mode is set', eq(r.fake.calls.displayMethod, ['PLAYER_DISPLAY_MODE_LETTER_BOX']));
  check('the display rect is the full panel', eq(r.fake.calls.displayRect, [[0, 0, 1920, 1080]]));
  await sleep(30);
  check('metadata is announced before playback',
    r.events.indexOf('loadedmetadata') >= 0 && r.events.indexOf('canplay') >= 0);
  check('duration is a number after prepare', r.backend.duration === 600);
  check('play was requested', r.fake.calls.play === 1);
  await sleep(350);
  check('playing is reported from the poll', r.events.includes('playing'));
  check('timeupdate is reported', r.events.includes('timeupdate'));
  check('paused is false while playing', r.backend.paused === false);
  r.backend.close();
  check('close stops and closes the native player',
    r.fake.calls.stop >= 1 && r.fake.calls.close >= 1);
}

// ── Pause and the transport ───────────────────────────────
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.backend.pause();
  check('pause calls the native player', r.fake.calls.pause === 1);
  check('pause emits pause', r.events.includes('pause'));
  check('paused reports true at once', r.backend.paused === true);
  const before = r.events.filter((e) => e === 'play').length;
  r.backend.play();
  check('play emits play immediately',
    r.events.filter((e) => e === 'play').length === before + 1);
  r.backend.close();
}

// ── Seek targets, the burst deferral and the getter ───────
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(30);
  const before = r.fake.calls.seek.length;
  r.backend.currentTime = 15;
  r.backend.currentTime = 30;
  r.backend.currentTime = 45;
  check('the first press is issued at once',
    eq(r.fake.calls.seek.slice(before), [15000]),
    `seeks=${r.fake.calls.seek.slice(before).join(',')}`);
  check('the getter reports the burst target while it waits',
    r.backend.currentTime === 45);
  check('a deferred seek still reports itself as seeking',
    r.backend.seeking === true);
  await sleep(700);
  check('the burst collapses into one seek for its final target',
    eq(r.fake.calls.seek.slice(before), [15000, 45000]),
    `seeks=${r.fake.calls.seek.slice(before).join(',')}`);
  check('the seek settles and the getter follows the poll', r.backend.currentTime >= 44);
  r.backend.close();
}

// A press long after the previous one is not a burst and keeps its latency.
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(30);
  const before = r.fake.calls.seek.length;
  r.backend.currentTime = 15;
  await sleep(500);
  r.backend.currentTime = 30;
  check('a discrete second press is issued at once',
    eq(r.fake.calls.seek.slice(before), [15000, 30000]),
    `seeks=${r.fake.calls.seek.slice(before).join(',')}`);
  r.backend.close();
}

// ── A refused codec is content, and `.error` lands first ──
{
  const r = rig({ failPrepare: true });
  r.backend.open('http://x/wmv2.avi');
  await sleep(40);
  const i = r.events.indexOf('error');
  check('prepare failure emits error', i >= 0);
  check('.error is set before the event', r.events[i + 1] === 'error:set');
  check('a refused codec is classified as content', r.backend.getLastFailure()?.level === 'content');
  check('the refusal names the phase', r.backend.getLastFailure()?.phase === 'prepare');
  check('the refused session is closed', r.fake.calls.close >= 1);
  r.backend.close();
}

// ── An engine fault is engine-level ───────────────────────
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.fake.fireError({ name: 'PLAYER_ERROR_INVALID_STATE' });
  check('runtime engine fault is classified as engine',
    r.backend.getLastFailure()?.level === 'engine');
  check('the error event is emitted once',
    r.events.filter((e) => e === 'error').length === 1);
  r.backend.close();
}

// ── Completion ────────────────────────────────────────────
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.fake.complete();
  check('onstreamcompleted emits ended', r.events.includes('ended'));
  check('ended reports paused', r.backend.paused === true);
  r.backend.close();
}

// ── A failure stops the poll ──────────────────────────────
// The poll used to re-arm from inside the tick that failed the session, and
// kept reading a closed native player.
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.fake.fireError({ name: 'PLAYER_ERROR_INVALID_STATE' });
  const atFailure = r.fake.calls.state;
  await sleep(700);
  check('the poll stops after a failure', r.fake.calls.state === atFailure,
    `${r.fake.calls.state - atFailure} further polls`);
  r.backend.close();
}

// ── The end of a scene stops the poll, once ───────────────
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.fake.complete();
  r.fake.complete();
  const atEnd = r.fake.calls.state;
  await sleep(700);
  check('the poll stops after the scene ends', r.fake.calls.state === atEnd,
    `${r.fake.calls.state - atEnd} further polls`);
  check('a repeated completion emits ended once',
    r.events.filter((e) => e === 'ended').length === 1);
  r.backend.close();
}

// ── The near-end fallback stops the poll from inside the tick ──
// `onstreamcompleted` never arrives, so finishEnded() runs from the poll's
// near-end verdict and the poll must refuse to re-arm.
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.fake.setDuration(600000);
  r.fake.setPosition(599500);
  const end = Date.now() + 5000;
  while (Date.now() < end && !r.events.includes('ended')) await sleep(100);
  check('the near-end fallback ends the scene', r.events.includes('ended'));
  const atEnd = r.fake.calls.state;
  await sleep(700);
  check('the poll stops after the fallback ending', r.fake.calls.state === atEnd,
    `${r.fake.calls.state - atEnd} further polls`);
  r.backend.close();
}

// ── A stuck seek recovers natively, never by ending the session ──
// A seek AVPlay accepts and never finishes says nothing about the file: the
// stream still decodes. The scene must stay on this engine, so the session is
// reopened at the target. Failing here is what switched a 4K skim to the
// browser even under `TV player`.
{
  const r = rig({ stuckSeeks: 1 }, { seekGiveUpMs: 4000 });
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.backend.currentTime = 60;
  const reopened = await (async () => {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      if (r.fake.calls.open.length >= 2 && r.backend.currentTime >= 58.5) return true;
      await sleep(100);
    }
    return false;
  })();
  check('a stuck seek reopens the session at the target', reopened,
    `opens=${r.fake.calls.open.length} currentTime=${r.backend.currentTime}`);
  check('...without reporting a failure', r.backend.error == null);
  check('...and the new session is asked to play',
    r.fake.calls.play >= 2, `plays=${r.fake.calls.play}`);
  r.backend.close();
}

// The reopen budget is finite: a file that can never seek must not reopen
// forever, and it still must not end the session.
{
  const r = rig({ stuckSeeks: 99 }, { seekGiveUpMs: 1000 });
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.backend.currentTime = 30;
  const end = Date.now() + 6000;
  while (Date.now() < end && r.fake.calls.open.length < 3) await sleep(100);
  // Longer than one deadline: a third reopen would happen in this window.
  await sleep(1800);
  check('the reopen budget is bounded', r.fake.calls.open.length === 3,
    `opens=${r.fake.calls.open.length}`);
  check('...and the session is never failed', r.backend.error == null);
  r.backend.close();
}

// A recovered scene that then plays is not a broken file, so a later bad seek
// must find a fresh reopen budget instead of a spent one. Without this, the
// second or third skim in a long sitting froze on AVPlay with no recovery.
{
  const r = rig({}, { seekGiveUpMs: 1000, recoveryResetMs: 400 });
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  let opens = r.fake.calls.open.length;
  let allRecovered = true;
  for (const target of [30, 60, 90]) {
    r.fake.setStuckSeeks(1);
    r.backend.currentTime = target;
    const recovered = await (async () => {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        if (r.fake.calls.open.length >= opens + 1
            && Math.abs(r.fake.api.getCurrentTime() / 1000 - target) <= 1.5) {
          return true;
        }
        await sleep(50);
      }
      return false;
    })();
    allRecovered = allRecovered && recovered;
    opens = r.fake.calls.open.length;
    // A genuinely quiet interlude: the reopen's own seek is still in flight
    // for one poll, so a shorter sleep never reaches recoveryResetMs.
    await sleep(1500);
  }
  check('a healthy interlude gives the next bad seek its own reopen budget',
    allRecovered && r.fake.calls.open.length === 4,
    `opens=${r.fake.calls.open.length} currentTime=${r.backend.currentTime}`);
  check('...without failing the session', r.backend.error == null);
  r.backend.close();
}

// ── An arrived seek recovers natively, not in the browser ──
// A position at the target proves the file is seekable, the session stopped:
// so the backend reopens the source there and keeps the hardware decoder. Only
// a seek that never arrived falls back.
{
  const r = rig({}, { seekGiveUpMs: 4000 });
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  // The seek lands, but the panel stays paused on it: re-asserting play does
  // nothing. That is the 'arrived' shape, not a stuck seek.
  r.fake.api.play = () => { r.fake.calls.play += 1; };
  r.backend.currentTime = 30;
  r.fake.setState('PAUSED');
  const reopened = await (async () => {
    const end = Date.now() + 5500;
    while (Date.now() < end) {
      if (r.fake.calls.open.length >= 2
          && r.fake.calls.seek.filter((ms) => ms === 30000).length >= 2) return true;
      await sleep(100);
    }
    return false;
  })();
  check('an arrived seek reopens the session instead of falling back', reopened,
    `opens=${r.fake.calls.open.length} error=${r.backend.error?.name || 'none'}`);
  check('...at the position the user asked for',
    r.fake.calls.seek.filter((ms) => ms === 30000).length >= 2,
    `seeks=${r.fake.calls.seek.join(',')}`);
  check('...without reporting a failure', r.backend.error == null);
  check('...and the engine is no longer marked degraded',
    r.backend.isSeekDegraded() === false);
  r.backend.close();
}

// ── A read failure after a seek recovers natively ──
// The panel reported CONNECTION_FAILED after a deep 4K skim: the seek landed,
// playback did not resume, and the error read as "this format is refused", so
// the scene moved to the browser and the format was exiled for the session.
// A read that fails soon after a seek is the new byte range, not the file.
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.backend.currentTime = 60;
  await sleep(600); // the position lands and the coalescer settles
  r.fake.fireError({ name: 'PLAYER_ERROR_CONNECTION_FAILED', code: -7 });
  const recovered = await (async () => {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (r.fake.calls.open.length >= 2 && r.backend.currentTime >= 59) return true;
      await sleep(50);
    }
    return false;
  })();
  check('a read failure soon after a seek reopens at the position', recovered,
    `opens=${r.fake.calls.open.length} currentTime=${r.backend.currentTime}`);
  check('...without failing the session', r.backend.error == null);
  check('...and without recording a refusal', r.backend.getLastFailure() == null);
  r.backend.close();
}

// The reopen itself can be refused, usually because the old decoder had not
// finished releasing. One retry, then it is a seek failure.
{
  const r = rig({ failRecoveryPrepares: 1 });
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.backend.currentTime = 60;
  await sleep(600);
  r.fake.fireError({ name: 'PLAYER_ERROR_CONNECTION_FAILED', code: -7 });
  const recovered = await (async () => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      if (r.fake.calls.open.length >= 3 && r.backend.currentTime >= 59) return true;
      await sleep(50);
    }
    return false;
  })();
  check('a refused recovery reopen is retried once', recovered,
    `opens=${r.fake.calls.open.length} error=${r.backend.error?.name || 'none'}`);
  check('...and the session survives the first refusal', r.backend.error == null);
  r.backend.close();
}

{
  const r = rig({ failRecoveryPrepares: 2 });
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.backend.currentTime = 60;
  await sleep(600);
  r.fake.fireError({ name: 'PLAYER_ERROR_CONNECTION_FAILED', code: -7 });
  const end = Date.now() + 4000;
  while (Date.now() < end && !r.backend.error) await sleep(50);
  check('a recovery that cannot reopen reports a seek failure, not a refusal',
    r.backend.error?.level === 'transient'
      && r.backend.getLastFailure()?.phase === 'seek',
    `level=${r.backend.error?.level} phase=${r.backend.getLastFailure()?.phase}`);
  check('...with a message that says the TV player could not recover',
    /could not recover/.test(r.backend.error?.message || ''),
    r.backend.error?.message);
  r.backend.close();
}

// Outside the window an error is still a verdict on the file.
{
  const r = rig({}, { postSeekErrorMs: 0 });
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.backend.currentTime = 60;
  await sleep(600);
  r.fake.fireError({ name: 'PLAYER_ERROR_CONNECTION_FAILED', code: -7 });
  await sleep(100);
  check('a read failure outside the post-seek window is still a refusal',
    r.backend.error?.level === 'content' && r.backend.error?.phase === 'runtime',
    `level=${r.backend.error?.level} phase=${r.backend.error?.phase}`);
  r.backend.close();
}

// ── A degraded HLS seek resumes instead of declaring a pause ──
// HLS seeks can degrade while playback survives, so the session is kept. The
// old path forgot that a play was still owed, the PAUSED branch read the
// rebuffer as a user pause and nothing asked again.
{
  const r = rig({}, { seekGiveUpMs: 4000 });
  r.backend.open('http://x/1.m3u8');
  await sleep(320);
  const before = r.events.length;
  // The seek lands but the picture stays paused: the 'arrived'/degraded shape.
  r.fake.api.play = () => { r.fake.calls.play += 1; };
  r.backend.currentTime = 40;
  r.fake.setState('PAUSED');
  // The 'arrived' verdict waits for the overall deadline (4 s here), not just
  // the HLS settle window.
  await sleep(4800);
  const after = r.events.slice(before);
  check('a degraded HLS seek does not declare a pause',
    !after.includes('pause'), `events=${after.join(',')}`);
  check('...and keeps asking for playback',
    r.fake.calls.play >= 2, `plays=${r.fake.calls.play}`);
  check('...without failing the session', r.backend.error == null);
  r.backend.close();
}

// ── A seek made from loadedmetadata wins over the open's startAt ──
// The player re-seeks a fallback at the live playhead from loadedmetadata; the
// open's start position used to be queued after that event and overwrote it.
{
  const fake = fakeAvplay();
  const events = [];
  let backend = null;
  const emit = (type) => {
    events.push(type);
    // Exactly what usePlayerMedia's handler does for a fallback source.
    if (type === 'loadedmetadata') backend.currentTime = 42;
  };
  backend = createAvplayBackend({ avplay: fake.api, emit, doc: fakeDoc(), win: fakeWin() });
  backend.open('http://x/1.mp4', { startSeconds: 30 });
  await sleep(400);
  check('the start position is issued before metadata is announced',
    eq(fake.calls.seek.slice(0, 2), [30000, 42000]),
    `seeks=[${fake.calls.seek.join(',')}]`);
  check('the loadedmetadata seek is the one that lands',
    backend.currentTime >= 41, `currentTime=${backend.currentTime}`);
  backend.close();
}

// ── Replay after the end re-arms the poll ─────────────────
// finishEnded() leaves the completion latch set and the poll stopped; playing
// again used to emit `play` and then nothing.
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.fake.complete();
  await sleep(600);          // the poll from before the end is gone
  const before = r.events.filter((e) => e === 'timeupdate').length;
  r.fake.setPosition(9000);
  r.backend.play();
  await sleep(450);
  check('replay after ended reports playing again',
    r.events.filter((e) => e === 'playing').length >= 2);
  // Playback is rewound first; the fake does not advance time on its own, so
  // the next position is what proves the poll is running.
  check('replay after ended rewinds to the start', r.fake.calls.seek.at(-1) === 0);
  r.fake.setPosition(500);
  await sleep(450);
  check('replay after ended resumes timeupdate',
    r.events.filter((e) => e === 'timeupdate').length > before);
  check('replay after ended is not paused', r.backend.paused === false);
  r.backend.close();
}

// ── Seeking back into a finished scene settles too ────────
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.fake.complete();
  await sleep(600);
  r.backend.currentTime = 5;
  // The replaying poll runs at the paused interval (500 ms): the scene ended,
  // so nothing has asked for playback.
  await sleep(700);
  check('a seek backwards from the end settles',
    r.backend.seeking === false && r.backend.currentTime >= 4.9,
    `seeking=${r.backend.seeking} currentTime=${r.backend.currentTime}`);
  r.backend.close();
}

// ── Hide → suspend, return → no-args restore at the saved position ──
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(320);
  r.fake.setPosition(40000);
  await sleep(300);           // the poll caches 40 s
  r.doc.visibilityState = 'hidden';
  r.doc.fire('visibilitychange');
  check('hidden calls suspend()', r.fake.calls.suspend === 1);
  check('hidden emits pause', r.events.filter((e) => e === 'pause').length >= 1);
  // The position drifts while suspended, a real panel moved +3–5 s.
  r.fake.setPosition(46000);
  r.doc.visibilityState = 'visible';
  r.doc.fire('visibilitychange');
  await sleep(400);
  check('restore is called with no arguments', eq(r.fake.calls.restore, [[]]));
  check('the saved position is re-asserted', r.fake.calls.seek.includes(40000));
  check('playback resumes', r.fake.calls.play >= 2);
  check('playing is emitted after restore',
    r.events.filter((e) => e === 'playing').length >= 2);
  r.backend.close();
  check('close unbinds visibility', r.doc.count('visibilitychange') === 0);
}

// ── Hide releases the panel mute; return puts it back ─────
// tvaudiocontrol is panel-wide, and a widget torn down while hidden never runs
// close(), so no mute of ours may outlive the hide.
{
  const fake = fakeAvplay();
  const tv = {
    muted: false,
    calls: [],
    setMute(v) { this.calls.push(v); this.muted = v; },
    isMute() { return this.muted; },
    getVolume() { return 13; },
  };
  const doc = fakeDoc();
  const backend = createAvplayBackend({
    avplay: fake.api, tvaudiocontrol: tv, emit: () => {}, doc, win: null,
  });
  backend.open('http://x/1.mp4');
  await sleep(40);
  backend.setMuted(true);
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  check('hiding releases the TV mute', tv.muted === false);
  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');
  await sleep(100);
  check('returning restores the mute', tv.muted === true && backend.muted === true);
  backend.close();
}

// ── TV mute: applied, and restored only by the app ────────
{
  const fake = fakeAvplay();
  const tv = {
    muted: false,
    calls: [],
    setMute(v) { this.calls.push(v); this.muted = v; },
    isMute() { return this.muted; },
    getVolume() { return 13; },
  };
  const events = [];
  const backend = createAvplayBackend({
    avplay: fake.api, tvaudiocontrol: tv, emit: (t) => events.push(t), doc: null, win: null,
  });
  check('tvaudio is chosen when the TV exposes it',
    backend.capabilities.mute === 'tvaudio');
  backend.open('http://x/1.mp4');
  check('the initial TV state is reflected', backend.muted === false);
  backend.setMuted(true);
  check('muting calls the TV', eq(tv.calls, [true]));
  check('the requested state is reported at once', backend.muted === true);
  backend.close();
  check('close restores the TV to how it was found', eq(tv.calls, [true, false]));
  check('and the backend no longer claims a mute', backend.muted === false);
}

// ── A mute pressed before prepare is retried on prepare ───
// The setVolume rung needs a live session; a mute landing while `prepareAsync`
// is in flight used to throw, revert the button, and start the scene with sound.
{
  const fake = fakeAvplay();
  const volumes = [];
  const stateOf = () => fake.api.getState();
  fake.api.getVolume = () => 100;
  fake.api.setVolume = (v) => {
    if (!['READY', 'PAUSED', 'PLAYING'].includes(stateOf())) {
      throw new Error('invalid state');
    }
    volumes.push(v);
  };
  const backend = createAvplayBackend({ avplay: fake.api, emit: () => {} });
  check('setVolume is the fallback capability', backend.capabilities.mute === 'setVolume');
  backend.open('http://x/1.mp4', { muted: true });
  await sleep(40);
  check('a mute requested before prepare is applied once prepared',
    eq(volumes, [0]) && backend.muted === true,
    `volumes=[${volumes.join(',')}] muted=${backend.muted}`);

  // A queue advance opens a new session at the panel's own level. The
  // remembered `muted` described the old session; keeping it made the
  // onPrepared retry look applied, so the new scene played with sound.
  backend.open('http://x/2.mp4', { muted: true });
  await sleep(40);
  check('a mute survives into the next native session',
    eq(volumes, [0, 0]) && backend.muted === true,
    `volumes=[${volumes.join(',')}] muted=${backend.muted}`);
  backend.close();
}

// ── The TV mute is re-read between scenes ──────────────────
// Nothing reports a remote mute, so a baseline sampled once per sitting left
// the button stale. With no app preference, each open re-reads the panel.
{
  const fake = fakeAvplay();
  const tv = {
    muted: false,
    calls: [],
    setMute(v) { this.calls.push(v); this.muted = v; },
    isMute() { return this.muted; },
    getVolume() { return 13; },
  };
  const backend = createAvplayBackend({ avplay: fake.api, tvaudiocontrol: tv, emit: () => {} });
  backend.open('http://x/1.mp4');
  await sleep(40);
  const first = backend.muted;
  tv.muted = true;                 // the remote, between scenes
  backend.open('http://x/2.mp4');
  await sleep(40);
  check('a remote mute between scenes is picked up',
    first === false && backend.muted === true,
    `first=${first} next=${backend.muted}`);
  check('...and the app does not fight it', eq(tv.calls, []));
  backend.close();
  check('closing leaves the remote mute alone', eq(tv.calls, []));
}

// ── A remote mute survives close ───────────────────────────
// Closing the player must not unmute a TV muted with the remote.
{
  const fake = fakeAvplay();
  const tv = {
    muted: true,
    calls: [],
    setMute(v) { this.calls.push(v); this.muted = v; },
    isMute() { return this.muted; },
    getVolume() { return 13; },
  };
  const backend = createAvplayBackend({ avplay: fake.api, tvaudiocontrol: tv, emit: () => {} });
  backend.open('http://x/1.mp4');
  check('a remote mute is reflected in the button', backend.muted === true);
  backend.close();
  check('a remote mute is not undone by closing', eq(tv.calls, []));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
