#!/usr/bin/env node
/**
 * test-avplay-backend.mjs — the AVPlay adapter's contract, off-device.
 *
 *   node scripts/test-avplay-backend.mjs
 *
 * The fake here is deliberately tiny: it only implements the calls the probe
 * measured and the backend actually makes. What this pins is everything the
 * TV would otherwise have to tell us on every run:
 *
 *   - the event order the player's hooks expect (metadata → play → playing)
 *   - the error contract (`.error` set *before* `error` is emitted, and a
 *     refused codec classified as content, not as a broken engine)
 *   - the seek contract (the coalescer's targets, and the getter reporting
 *     the pending target)
 *   - suspend/restore, including the no-args restore this panel insists on
 *   - TV mute and its restore-on-close rule
 *
 * No framework. Real timers; the waits are a few hundred milliseconds.
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
function fakeAvplay({ failPrepare = false, prepareMs = 5 } = {}) {
  let state = 'IDLE';
  let position = 0;
  const calls = {
    open: [], close: 0, stop: 0, play: 0, pause: 0, seek: [],
    suspend: 0, restore: [], displayMethod: [], displayRect: [],
  };
  let listener = null;
  const api = {
    open(url) { calls.open.push(url); state = 'OPENED'; position = 0; },
    setListener(l) { listener = l; },
    setDisplayRect(...a) { calls.displayRect.push(a); },
    setDisplayMethod(m) { calls.displayMethod.push(m); },
    prepareAsync(ok, bad) {
      state = 'PREPARING';
      setTimeout(() => {
        if (failPrepare) {
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
    seekTo(ms, ok) { calls.seek.push(ms); position = ms; setTimeout(() => ok?.(), 0); },
    suspend() { calls.suspend += 1; if (state === 'PLAYING') state = 'SUSPENDED'; },
    restore(...args) {
      calls.restore.push(args);
      if (args.length) throw new TypeError('restore() takes no arguments');
      if (state === 'SUSPENDED') state = 'PLAYING';
    },
    getState: () => state,
    getCurrentTime: () => position,
    getDuration: () => 600000,
  };
  return {
    api,
    calls,
    fireError: (raw) => listener?.onerror?.(raw),
    complete: () => listener?.onstreamcompleted(),
    setPosition: (ms) => { position = ms; },
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
    fire(type) { listeners.get(type)?.forEach((fn) => fn()); },
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
    fire(type) { listeners.get(type)?.forEach((fn) => fn()); },
  };
}

function rig(opts = {}) {
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
  backend = createAvplayBackend({ avplay: fake.api, emit, doc, win });
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

// ── Seek targets and the getter ───────────────────────────
{
  const r = rig();
  r.backend.open('http://x/1.mp4');
  await sleep(30);
  r.backend.currentTime = 15;
  r.backend.currentTime = 30;
  r.backend.currentTime = 45;
  check('three presses issue three seeks, the latest last',
    eq(r.fake.calls.seek.slice(-3), [15000, 30000, 45000]));
  check('the getter reports the pending target', r.backend.currentTime === 45);
  await sleep(300);
  check('the seek settles and the getter follows the poll', r.backend.currentTime >= 44);
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
  // The position drifts while suspended — a real panel moved +3–5 s.
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

// A TV muted with the remote must not be unmuted by closing the player.
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
