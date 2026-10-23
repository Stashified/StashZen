/**
 * Headless driver for the TV engine — AVPlay behind the media facade.
 *
 * The one thing this driver cannot do is play anything through AVPlay: the
 * engine exists only on the TV, and the browser has none. So a stand-in
 * (`fakeAvplay.js`, built with the backend) records the calls and reports the
 * states the Phase 0 probe measured, and everything asserted here is what the
 * *app* did with them — which URL it opened, whether a `<video>` existed when
 * it opened, what the page looked like while the plane was up, and where the
 * player went when the engine refused.
 *
 * What that leaves untested is stated plainly rather than implied: whether
 * AVPlay decodes a codec, whether the picture is visible above a transparent
 * page, whether a hide/return really restores audio, and what the panel's mute
 * OSD does. Those are the TV pass's checklist. This driver proves the decisions
 * and the DOM around them.
 *
 * Groups:
 *   A — the ordinary path: AVPlay opens the scene, no `<video>` exists, the
 *       plane is transparent, the poster covers it until the first frame, the
 *       stats panel tells the truth, skims accumulate, and hide/return
 *       suspends and restores.
 *   B — a prepare refusal: content-level, so the browser plays the same file,
 *       the plane comes down, and the *next* scene of that format skips AVPlay
 *       entirely (the per-format negative cache).
 *   C — a refusal mid-play: the browser takes over at the playhead, not zero.
 *   D — HLS is preferred: every AVPlay transcoded candidate is HLS first, and
 *       the browser's own HLS-then-MP4 walk keeps the same order.
 *   E — the kill switch: two engine-level failures on different scenes turn
 *       AVPlay off for the rest of the session, and the stats panel says so.
 *   F — a slow seek: the engine holds the position past one settle window, and
 *       the player waits for it instead of re-issuing the seek each window.
 *   G — a paused skim, and the seek deadlines that must not fire on it.
 *   H — the shipped `Auto` policy: browser first. An ordinary scene never opens
 *       AVPlay; a format the browser cannot demux goes to AVPlay directly; a
 *       browser that accepts and stalls is handed over at 4 s, and that format
 *       skips the browser for the rest of the session.
 *
 * Groups A–G run under `TV player`, so they keep testing the AVPlay path they
 * were written for. Group H switches to `Auto` and is the only one that
 * asserts the default's ordering.
 *
 * The fake is installed before React mounts, because `usePlayerEngine` reads
 * `window.webapis.avplay` during render. Modes are flipped per group through
 * the fake's own `mode` Set; `calls` is cleared between groups so each
 * assertion counts only what its group did.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import VideoPlayer from '../../src/components/VideoPlayer.jsx';
import { setSettings } from '../../src/utils/settings.js';
import { installFakeAvplay } from './fakeAvplay.js';
// The plane's rules live in the app stylesheet, so a driver that asserts on
// them has to load it — the overlay's own class rules arrive with the
// component, but "hide every shell child but the host" does not.
import '../../src/index.css';

const PORT = window.__PORT__;
const fake = installFakeAvplay({ prepareDelayMs: 200 });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, ms = 5000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

// ── The fake's own bookkeeping ──────────────────────────────
/** Zero every counter, so a group's assertions describe only that group. */
function clearCalls() {
  for (const key of Object.keys(fake.calls)) {
    const value = fake.calls[key];
    if (Array.isArray(value)) value.length = 0;
    else fake.calls[key] = 0;
  }
}

const AVPLAY_OPENS = () => fake.calls.open;
const VIDEO_AT_OPEN = () => fake.calls.videoPresentAtOpen;

// ── The page ────────────────────────────────────────────────
const planeOn = () => document.documentElement.hasAttribute('data-avplay-plane');
const videoEl = () => document.querySelector('video');
const hostEl = () => document.querySelector('[data-player-host]');
const shellSibling = () => document.querySelector('[data-shell-sibling]');
const posterEl = () => document.querySelector('img[class*="poster"]');
const chipText = () =>
  document.querySelector('[class*="sourceChip"]')?.textContent?.trim() || '';
const statsButton = () => document.querySelector('button[aria-label="Playback info"]');
const statsPanel = () => document.querySelector('[role="group"][aria-label="Playback info"]');
const statsText = () => (statsPanel()?.textContent || '').replace(/\s+/g, ' ');
const errorText = () => document.querySelector('[class*="errorState"]')?.textContent || '';
const hasData = () => (videoEl()?.readyState ?? 0) >= 2;
/** The rail's "n / total" counter, so a queue advance can be awaited by scene
 *  rather than by a URL the plan may well transcode. */
const sceneCounter = () =>
  // `textContent` has no layout whitespace: the counter is "1/3" and the next
  // thing in the tree may be a clock, so "1/3" can sit at the start of
  // "1/300:12". Match the prefix; the number is all this needs.
  (document.body.textContent.match(/(\d+)\s*\/\s*3/) || [])[1] || '';
const playingNow = () => !!videoEl() && hasData() && !videoEl().paused && !planeOn();
const bg = (el) => getComputedStyle(el).backgroundColor;

const press = (key, keyCode) => window.dispatchEvent(new KeyboardEvent('keydown', {
  key, keyCode, which: keyCode, bubbles: true, cancelable: true,
}));

async function openStats() {
  statsButton()?.click();
  return waitFor(() => !!statsPanel(), 2000);
}
async function closeStats() {
  statsButton()?.click();
  await sleep(150);
}

// ── Scenes ──────────────────────────────────────────────────
const at = (path) => `http://127.0.0.1:${PORT}${path}`;
/** Server-side request timestamps for `/hang/` sources, epoch ms (see H3). */
const getHangHits = () =>
  fetch(at('/hanghits')).then(r => r.json()).catch(() => []);
const scene = (over) => ({
  id: '9200',
  title: 'VERIFY avplay',
  stream: null,
  thumbnail: null,
  durationSeconds: 60,
  resume_time: 0,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4',
  ...over,
});

function Harness() {
  const [mount, setMount] = useState(null);

  useEffect(() => {
    window.__mount = (items, startIndex = 0) => {
      setMount({
        gen: (window.__gen = (window.__gen || 0) + 1),
        queue: {
          items,
          total: items.length,
          page: 1,
          startIndex,
          startSeconds: 0,
          fetchPage: null,
        },
      });
    };
    window.__unmount = () => setMount(null);
  }, []);

  return (
    <div data-app-shell="">
      {/* A sibling of the player host, and a <button> so "focus cannot reach
          it" is a real question rather than a tabindex one. The plane rule
          hides it; the player above stays visible. */}
      <button type="button" data-shell-sibling="">shell</button>
      {mount && (
        <VideoPlayer key={mount.gen} queue={mount.queue} onClose={() => {}} />
      )}
    </div>
  );
}

async function unmountPlayer() {
  window.__unmount();
  await sleep(250);
}

/** A fresh player session, with the fake's counters zeroed. */
async function remount(items, { clear = true } = {}) {
  await unmountPlayer();
  if (clear) clearCalls();
  window.__mount(items);
  await sleep(250);
}

// ── A: the ordinary AVPlay path ─────────────────────────────
async function groupA() {
  await remount([scene({
    id: '9201',
    stream: at('/tone9201.wav'),
    thumbnail: at('/scene/9201/thumb.png'),
  })]);

  const opened = await waitFor(() => AVPLAY_OPENS().length >= 1, 4000);
  check('A1 the scene is opened on AVPlay',
    opened && AVPLAY_OPENS()[0].endsWith('/tone9201.wav'),
    AVPLAY_OPENS()[0] || '(no open)');

  check('A1 and no <video> exists in the document when it opens',
    !videoEl() && VIDEO_AT_OPEN().length > 0 && VIDEO_AT_OPEN().every(v => v === false),
    `video=${!!videoEl()} recorded=[${VIDEO_AT_OPEN().join(',')}]`);

  // The picture is drawn *behind* the page, so the window between open and the
  // first frame is covered by the poster rather than by a see-through listing.
  const posterUp = await waitFor(() => !!posterEl(), 1500);
  check('A2 a poster covers the plane before the first frame',
    posterUp, posterUp ? 'poster present' : 'no poster');

  const playing = await waitFor(() => fake.state === 'PLAYING', 5000);
  const posterGone = await waitFor(() => !posterEl(), 2000);
  check('A2 ...and clears once the engine has a frame',
    playing && posterGone, `playing=${playing} poster=${!!posterEl()}`);

  // Compositing: the page is see-through, the shell is hidden, the host is not.
  const rootTransparent = bg(document.documentElement) === 'rgba(0, 0, 0, 0)';
  const hostBackground = hostEl() ? bg(hostEl()) : '';
  const hostTransparent = /rgba\(0, 0, 0, 0\)|transparent/.test(hostBackground);
  const siblingHidden = shellSibling()
    && getComputedStyle(shellSibling()).visibility === 'hidden';
  const hostVisible = hostEl()
    && getComputedStyle(hostEl()).visibility === 'visible';
  check('A3 the page is transparent and the shell hidden while the plane is up',
    planeOn() && rootTransparent && hostTransparent && siblingHidden && hostVisible,
    `plane=${planeOn()} root=${bg(document.documentElement)} `
    + `host=${hostBackground} sibling=${shellSibling()
      ? getComputedStyle(shellSibling()).visibility : 'missing'} `
    + `hostVis=${hostEl() ? getComputedStyle(hostEl()).visibility : 'missing'}`);

  // Hiding the shell is only useful if the cursor cannot reach into it. A
  // hidden element is not focusable; this is the check that says so.
  const sib = shellSibling();
  sib?.focus();
  check('A3 focus cannot land on anything the plane has hidden',
    !!sib && document.activeElement !== sib,
    `activeElement=${document.activeElement?.tagName || 'none'}`);
  sib?.blur();

  // Positioning, so skims have something to accumulate from.
  fake.advance(20000);
  await sleep(600);

  const statsOpened = await openStats();
  const text = statsText();
  check('A4 the readout names AVPlay and leaves out what it cannot know',
    statsOpened && text.includes('Player') && text.includes('AVPlay')
    && !text.includes('Buffer ahead') && !text.includes('Frames')
    && !text.includes('Resolution') && !text.includes('Seekable'),
    text.slice(0, 180));
  check('A4 the readout carries the engine\'s duration and position',
    text.includes('Stream duration') && text.includes('Position')
    && text.includes('10:00'),
    text.slice(0, 180));
  check('A4 and never prints the credential behind the stream',
    !/apikey/i.test(text) && text.includes('/tone9201.wav')
    && !/apikey/i.test(document.body.innerText),
    text.slice(0, 180));
  await closeStats();

  // Five presses inside one gesture. The failure this catches is a getter that
  // returns the last *poll* instead of the pending target, which moves the
  // user 15 s instead of 75.
  const before = fake.positionMs;
  for (let i = 0; i < 5; i += 1) {
    press('ArrowRight', 39);
    await sleep(15);
  }
  await sleep(400);
  const seeks = fake.calls.seek;
  const first = seeks[0];
  const last = seeks[seeks.length - 1];
  check('A5 five rapid skims accumulate to +75 s rather than collapsing to one',
    seeks.length === 5 && Math.abs((last - first) / 1000 - 60) <= 2
    && Math.abs(last / 1000 - (before / 1000 + 75)) <= 3,
    `targets=${seeks.map(s => Math.round(s / 1000)).join(',')} from ${(before / 1000).toFixed(1)} s`);

  // ── Hide and return ──
  const positionAtHide = fake.positionMs;
  let visibility = 'hidden';
  try {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: () => visibility,
    });
  } catch (e) { /* the prototype getter is what the backend would read */ }
  document.dispatchEvent(new Event('visibilitychange'));
  await sleep(500);
  check('A6 hiding the app suspends the native session',
    fake.calls.suspend === 1 && fake.state === 'SUSPENDED',
    `suspend=${fake.calls.suspend} state=${fake.state}`);

  const parked = fake.positionMs;
  await sleep(1200);
  check('A6 and the media clock does not advance while hidden',
    fake.positionMs === parked, `${(parked / 1000).toFixed(1)} s → `
    + `${(fake.positionMs / 1000).toFixed(1)} s over 1.2 s hidden`);

  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await sleep(900);
  try { delete document.visibilityState; } catch (e) { /* keep the override */ }
  const restores = fake.calls.restore;
  check('A6 returning restores with the no-argument call this panel accepts',
    restores.length === 1 && restores[0].length === 0,
    `restore(${restores.map(a => JSON.stringify(a)).join(' | ')})`);
  check('A6 ...and playback continues where it was',
    fake.state === 'PLAYING' && Math.abs(fake.positionMs - positionAtHide) < 2000,
    `state=${fake.state} ${(positionAtHide / 1000).toFixed(1)} → `
    + `${(fake.positionMs / 1000).toFixed(1)} s`);
  check('A6 ...with the plane still up', planeOn(), `plane=${planeOn()}`);

  const closes = fake.calls.close;
  await unmountPlayer();
  await sleep(200);
  check('A7 closing the player tears the native session down',
    fake.calls.close > closes, `close calls ${closes} → ${fake.calls.close}`);
  check('A7 and the page is visible again',
    !planeOn() && !videoEl(), `plane=${planeOn()} video=${!!videoEl()}`);
}

// ── B: a prepare refusal is content, not an engine fault ────
async function groupB() {
  fake.mode.add('failPrepare');
  // Two scenes of the *same* container/codec triple in one player session:
  // the cache is session-scoped by design (a new server's library must not
  // inherit another's refusals), so re-mounting between them would test
  // nothing.
  await remount([
    scene({ id: '9202', stream: at('/tone9202.wav') }),
    scene({ id: '9203', stream: at('/tone9203.wav') }),
  ]);

  const played = await waitFor(
    () => hasData() && (videoEl()?.currentSrc || '').includes('/tone9202.wav'), 9000);
  check('B1 a refused prepare falls back to the browser, which plays the file',
    played, `video src ${videoEl()?.currentSrc || '(none)'}`);
  check('B1 no <video> existed at any of the AVPlay opens',
    VIDEO_AT_OPEN().length >= 1 && VIDEO_AT_OPEN().every(v => v === false),
    `recorded=[${VIDEO_AT_OPEN().join(',')}]`);
  check('B2 the plane comes down with the engine',
    !planeOn() && !errorText(), `plane=${planeOn()} error="${errorText()}"`);
  check('B2 and the source chip still says direct',
    chipText() === 'Direct play', `chip="${chipText()}"`);

  const opensBefore = AVPLAY_OPENS().length;
  press('ArrowDown', 40);
  const playedSame = await waitFor(
    () => hasData() && (videoEl()?.currentSrc || '').includes('/tone9203.wav'), 9000);
  check('B3 the next scene of that format skips AVPlay entirely',
    playedSame && AVPLAY_OPENS().length === opensBefore,
    `opens=${AVPLAY_OPENS().length} (was ${opensBefore}) played=${playedSame}`);

  fake.mode.delete('failPrepare');
}

// ── C: a failure after the picture started ──────────────────
async function groupC() {
  await remount([scene({
    id: '9204',
    stream: at('/tone9204.wav'),
    container: 'matroska', videoCodec: 'hevc',
  })]);
  const started = await waitFor(() => fake.state === 'PLAYING', 5000);
  fake.advance(12000);
  await sleep(600);
  const before = fake.positionMs;
  check('C1 setup: the AVPlay session reached the middle of the scene',
    started && before >= 12000, `position ${(before / 1000).toFixed(1)} s`);

  fake.fireError('PLAYER_ERROR_CONNECTION_FAILED', -7);
  const recovered = await waitFor(
    () => hasData() && (videoEl()?.currentSrc || '').includes('/tone9204.wav'), 9000);
  await sleep(500);
  const resumedAt = videoEl()?.currentTime ?? 0;
  check('C1 a stream that fails mid-play is re-opened on the browser',
    recovered, `video src ${videoEl()?.currentSrc || '(none)'}`);
  check('C2 ...without losing the playhead',
    resumedAt >= 10, `currentTime=${resumedAt.toFixed(1)} s after failing at `
    + `${(before / 1000).toFixed(1)} s`);
  check('C2 ...and the recovery is not shown as a failure',
    errorText() === '' && !planeOn(), `error="${errorText()}" plane=${planeOn()}`);
}

// ── D: HLS first, for either engine ─────────────────────────
async function groupD() {
  // Every prepare fails: that is what makes the walk reach the transcode
  // candidates at all, since the fake would otherwise accept the direct file.
  fake.mode.add('failPrepare');
  // Two scenes of one format in one session: the first pays for the refusal,
  // the second finds the format in the cache and goes straight to AVPlay's
  // HLS transcode — which is the state where the stats row used to read
  // "AVPlay · AVPlay refused this format".
  await remount([scene({
    id: '9205',
    stream: at('/tone9205.wav'),
    container: 'avi', videoCodec: 'wmv3', audioCodec: 'wmav2',
  }), scene({
    id: '9206',
    stream: at('/tone9206.wav'),
    container: 'avi', videoCodec: 'wmv3', audioCodec: 'wmav2',
  })]);

  const played = await waitFor(
    () => hasData() && (videoEl()?.src || '').includes('/scene/9205/stream.mp4'),
    16000);
  const opens = AVPLAY_OPENS();
  const transcodeOpens = opens.slice(1);
  check('D1 the direct file is tried on AVPlay first',
    opens.length >= 3 && opens[0].endsWith('/tone9205.wav'),
    `opens=${opens.length}: ${opens[0] || '(none)'}`);
  check('D1 the transcoded candidates are opened HLS before MP4 and WebM',
    transcodeOpens[0]?.includes('/stream.m3u8')
    && transcodeOpens[1]?.includes('/stream.mp4')
    && transcodeOpens[2]?.includes('/stream.webm'),
    transcodeOpens.map(u => u.replace(/^.*\/scene\/9205/, '')).join(', '));
  check('D2 no <video> existed at any AVPlay open, including the transcodes',
    VIDEO_AT_OPEN().length === opens.length && VIDEO_AT_OPEN().every(v => v === false),
    `opens=${opens.length} recorded=${VIDEO_AT_OPEN().length}`);

  const fetches = await fetch('/streamfetches').then(r => r.json());
  const hlsAt = fetches.findIndex(p => p.includes('/scene/9205/stream.m3u8'));
  const mp4At = fetches.findIndex(p => p.includes('/scene/9205/stream.mp4'));
  check('D2 the browser\'s own fallback keeps the same HLS-before-MP4 order',
    hlsAt !== -1 && (mp4At === -1 || hlsAt < mp4At),
    `requests: [${fetches.join(', ')}]`);
  check('D3 the scene plays through the browser transcode',
    played && chipText() === 'Transcoded' && !planeOn() && !errorText(),
    `src=${videoEl()?.currentSrc || '(none)'} chip="${chipText()}"`);

  // The same format again: direct AVPlay is skipped from the cache, and the
  // HLS transcode is played *by AVPlay*. The refusal note must stay off that
  // row — a cached refusal explains a browser fallback, not an AVPlay stream.
  fake.mode.delete('failPrepare');
  fake.mode.add('failDirect');
  press('ArrowDown', 40);
  const hlsOpened = await waitFor(
    () => fake.calls.open.some(u => u.includes('/scene/9206/stream.m3u8')), 9000);
  const avplayPlaying = await waitFor(
    () => hlsOpened && fake.state === 'PLAYING' && planeOn(), 6000);
  const statsUp = await openStats();
  const d4 = statsText();
  check('D4 the cached format goes straight to AVPlay\'s HLS transcode',
    avplayPlaying && !errorText() && chipText() === 'Transcoded',
    `opened=${hlsOpened} state=${fake.state} plane=${planeOn()} chip="${chipText()}"`);
  check('D4 ...and the readout does not call AVPlay the refusal it did not get',
    statsUp && d4.includes('AVPlay') && !/refused this format/.test(d4),
    d4.slice(0, 180));
  await closeStats();
  fake.mode.delete('failDirect');
}

// ── E: the session kill switch ──────────────────────────────
async function groupE() {
  // Engine-level failures, i.e. `open()` itself throwing. A *content* refusal
  // must never trip this — group B already proved it does not.
  fake.mode.add('failOpen');
  await remount([
    scene({ id: '9301', stream: at('/tone9301.wav'), container: 'mkv', videoCodec: 'hevc' }),
    scene({ id: '9302', stream: at('/tone9302.wav'), container: 'webm', videoCodec: 'av1' }),
    scene({ id: '9303', stream: at('/tone9303.wav'), container: 'mp4', videoCodec: 'vp9' }),
  ]);

  // Where the browser lands is the plan's business, not this group's: HEVC in
  // MKV has no browser-direct candidate, so scene A resumes on a transcode.
  // The engine question is just "did the scene start playing at all".
  const playedA = await waitFor(playingNow, 12000);
  const afterFirst = fake.calls.openAttempts.length;
  // The engine fault is per-candidate, not per-scene: a broken engine refuses
  // the direct file and then each AVPlay transcode, so this scene can cost
  // several attempts. What matters is that the *scene* played on the browser
  // and that one scene's failures did not disable the engine.
  check('E1 one engine failure falls back rather than disabling the engine',
    playedA && afterFirst >= 1,
    `attempts=${afterFirst} played=${playedA} `
    + `src=${videoEl()?.currentSrc || '(none)'}`);

  press('ArrowDown', 40);
  await waitFor(() => sceneCounter() === '2', 5000);
  const triedB = await waitFor(() => fake.calls.openAttempts.length >= 2, 5000);
  const playedB = await waitFor(playingNow, 9000);
  const afterSecond = fake.calls.openAttempts.length;
  check('E2 a second engine failure on a *different* scene is the limit',
    triedB && playedB && afterSecond > afterFirst,
    `scene=${sceneCounter()} attempts=${afterSecond} (was ${afterFirst}) `
    + `played=${playedB}`);

  press('ArrowDown', 40);
  await waitFor(() => sceneCounter() === '3', 5000);
  const playedC = await waitFor(playingNow, 9000);
  check('E3 once the kill switch trips, AVPlay is not tried again',
    sceneCounter() === '3' && playedC && fake.calls.openAttempts.length === afterSecond,
    `attempts=${fake.calls.openAttempts.length} (was ${afterSecond}) `
    + `scene=${sceneCounter()} played=${playedC}`);

  const opened = await openStats();
  const text = statsText();
  check('E4 the readout says why it is on the browser',
    opened && text.includes('Browser') && text.includes('AVPlay paused after errors'),
    text.slice(0, 180));
  await closeStats();
  fake.mode.delete('failOpen');
}

// ── F: a seek that takes longer than one window ─────────────
async function groupF() {
  // The 4K AV1 report: the engine accepts the seek, the picture freezes while
  // it decodes from the new keyframe, and the position does not move. The
  // first window expires during that hold — re-issuing the seek there is what
  // made it never finish.
  fake.mode.add('slowSeek');
  window.__fakeSlowSeekMs = 3000;
  await remount([scene({
    id: '9401', stream: at('/tone9401.wav'),
    container: 'mp4', videoCodec: 'av1', audioCodec: 'aac',
  })]);
  const started = await waitFor(() => fake.state === 'PLAYING' && planeOn(), 6000);
  await sleep(300);

  const before = fake.positionMs;
  const seeksBefore = fake.calls.seek.length;
  press('ArrowRight', 39);
  // Past one 1.5 s settle window, still inside the 3 s the engine takes.
  await sleep(2200);
  check('F1 a slow seek is not re-issued while the engine is working',
    started && fake.calls.seek.length - seeksBefore === 1,
    `seeks=${fake.calls.seek.length - seeksBefore} state=${fake.state}`);

  const target = before + 15000;
  const landed = await waitFor(
    () => Math.abs(fake.positionMs - target) < 3000, 6000);
  check('F2 ...and it lands when the engine finishes it', landed,
    `${(fake.positionMs / 1000).toFixed(1)} s vs ${(target / 1000).toFixed(1)} s`);

  await sleep(400);
  const statsUp = await openStats();
  const text = statsText();
  check('F3 ...without the panel calling it degraded',
    statsUp && !/degraded/i.test(text), text.slice(0, 180));
  await closeStats();

  fake.mode.delete('slowSeek');
  delete window.__fakeSlowSeekMs;
}

// ── G: a seek the engine handles badly ──────────────────────
async function groupG() {
  // G1 — the engine pauses itself to rebuffer a seek. Reading that PAUSED as
  // a user pause is how a scene stays frozen: `wantPlaying` goes false and
  // nothing asks the engine to play again. The player must ask again.
  fake.mode.add('pauseOnSeek');
  await remount([scene({
    id: '9402', stream: at('/tone9402.wav'),
    container: 'mp4', videoCodec: 'av1', audioCodec: 'aac',
  })]);
  const playingG1 = await waitFor(() => fake.state === 'PLAYING' && planeOn(), 6000);
  await sleep(300);
  const seeksBefore = fake.calls.seek.length;
  press('ArrowRight', 39);
  const resumed = await waitFor(() => fake.state === 'PLAYING', 5000);
  await sleep(300);
  check('G1 a seek that pauses the engine is resumed, not read as a user pause',
    playingG1 && resumed && planeOn(),
    `state=${fake.state} plane=${planeOn()}`);
  check('G1 ...with one seek and no engine switch',
    fake.calls.seek.length - seeksBefore === 1 && !videoEl(),
    `seeks=${fake.calls.seek.length - seeksBefore} video=${!!videoEl()}`);
  fake.mode.delete('pauseOnSeek');

  // G2 — the seek is accepted and never lands. The picture is frozen, the
  // position does not move, and no callback ever fires: the scene has to move
  // to the browser at the position the user asked for, rather than sit there.
  fake.mode.add('stuckSeek');
  await remount([scene({
    id: '9403', stream: at('/tone9403.wav'),
    container: 'mp4', videoCodec: 'av1', audioCodec: 'aac',
  })]);
  const playingG2 = await waitFor(() => fake.state === 'PLAYING' && planeOn(), 6000);
  await sleep(300);
  const before = fake.positionMs;
  press('ArrowRight', 39);
  const switched = await waitFor(
    () => hasData() && !planeOn()
      && (videoEl()?.currentSrc || '').includes('/tone9403.wav'), 12000);
  await sleep(700);
  const landedAt = videoEl()?.currentTime ?? 0;
  const target = (before + 15000) / 1000;
  check('G2 a seek that never lands moves the scene to the browser',
    playingG2 && switched, `plane=${planeOn()} src=${videoEl()?.currentSrc || '(none)'}`);
  check('G3 ...at the position the user asked for',
    Math.abs(landedAt - target) < 4,
    `${landedAt.toFixed(1)} s vs ${target.toFixed(1)} s`);
  check('G3 ...and the recovery is not shown as a failure',
    errorText() === '', `error="${errorText()}"`);
  fake.mode.delete('stuckSeek');

  // G4 — a skim made while the user has paused. Two traps meet here: the
  // engine never returns to PLAYING on its own (correctly — nobody asked it
  // to), and the seek still has to settle on arrival rather than run out the
  // direct deadline and be declared stuck. A false verdict here would switch
  // engines on a working scene and lose the native plane.
  await remount([scene({
    id: '9404', stream: at('/tone9404.wav'),
    container: 'mp4', videoCodec: 'av1', audioCodec: 'aac',
  })]);
  const playingG4 = await waitFor(() => fake.state === 'PLAYING' && planeOn(), 6000);
  await sleep(250);
  press(' ', 32);
  const pausedG4 = await waitFor(() => fake.state === 'PAUSED', 3000);
  const seeksG4 = fake.calls.seek.length;
  const pausedAtG4 = fake.positionMs;
  press('ArrowRight', 39);
  const seekIssuedG4 = await waitFor(() => fake.calls.seek.length > seeksG4, 3000);
  // Longer than the 4 s direct deadline: a settled seek never reaches it,
  // and a player that read the pause as a stall would have switched by now.
  await sleep(4800);
  check('G4 a skim while paused is not mistaken for a stuck seek',
    playingG4 && pausedG4 && seekIssuedG4 && planeOn() && !videoEl(),
    `state=${fake.state} plane=${planeOn()} video=${!!videoEl()}`
      + ` seeks=${fake.calls.seek.length - seeksG4}`);
  check('G4 ...the seek landed where it was asked to',
    Math.abs(fake.positionMs - (pausedAtG4 + 15000)) < 3000,
    `${(fake.positionMs / 1000).toFixed(1)} s vs `
      + `${((pausedAtG4 + 15000) / 1000).toFixed(1)} s`);
  press(' ', 32);
  const resumedG4 = await waitFor(() => fake.state === 'PLAYING', 3000);
  check('G4 ...and resuming plays on from there, still on AVPlay',
    resumedG4 && !videoEl(), `state=${fake.state} video=${!!videoEl()}`);
}

// ── H: the shipped default — browser first ─────────────────
// A–G force `TV player`; this group is what a new build does without being
// asked. Three claims, in the order the policy applies them:
//   H1 an ordinary file plays in the browser and never opens AVPlay;
//   H2 a file the browser cannot demux goes to AVPlay with no browser attempt;
//   H3/H4 a browser that accepts a source and never decodes it is handed over
//         at 4 s, and the *format* then skips the browser this session.
async function groupH() {
  setSettings({ playbackEngine: 'auto' });

  await remount([scene({
    id: '9410', stream: at('/tone9410.wav'),
    container: 'mp4', videoCodec: 'h264', audioCodec: 'aac',
  })]);
  const browserPlayed = await waitFor(() => playingNow(), 6000);
  await sleep(300);
  check('H1 an ordinary scene plays in the browser under Auto',
    browserPlayed && AVPLAY_OPENS().length === 0 && !planeOn() && !!videoEl(),
    `playing=${browserPlayed} opens=${AVPLAY_OPENS().length} `
      + `plane=${planeOn()} video=${!!videoEl()}`);

  // `needsTranscode` is true for this triple, so the plan starts on AVPlay's
  // direct candidate; the browser is never handed a container it cannot
  // demux. The fake accepts, which is all this assertion needs.
  await remount([scene({
    id: '9411', stream: at('/tone9411.wav'),
    container: 'wmv', videoCodec: 'wmv2', audioCodec: 'wmav2',
  })]);
  const openedH2 = await waitFor(() => AVPLAY_OPENS().length >= 1, 4000);
  check('H2 a browser-refused format goes straight to AVPlay under Auto',
    openedH2 && AVPLAY_OPENS()[0].endsWith('/tone9411.wav')
      && fake.calls.videoPresentAtOpen.every(v => v === false),
    `opens=${AVPLAY_OPENS().length} url=${AVPLAY_OPENS()[0] || '(none)'} `
      + `videoAtOpen=[${fake.calls.videoPresentAtOpen.join(',')}]`);

  // Two scenes of one *new* format in one player session. The first stream
  // hangs: the element accepts the connection and never produces metadata, so
  // only the watchdog can notice. Four seconds, not the transcode's ten,
  // because AVPlay is a real second opinion under Auto.
  // The watchdog is measured from the *request*, which the server timestamps;
  // a driver-side timer would start before the fetch and the mount and would
  // accept anything from a 2 s to a 6 s watchdog.
  const hangHitsBefore = await getHangHits();
  await remount([scene({
    id: '9412', stream: at('/hang/9412'),
    container: 'mp4', videoCodec: 'vp9', audioCodec: 'aac',
  }), scene({
    id: '9413', stream: at('/tone9413.wav'),
    container: 'mp4', videoCodec: 'vp9', audioCodec: 'aac',
  })]);
  const openedH3 = await waitFor(() => AVPLAY_OPENS().length >= 1, 9000);
  const handedAt = Date.now();
  const hangHit = (await getHangHits())[hangHitsBefore.length];
  const handoffMs = hangHit ? handedAt - hangHit : NaN;
  check('H3 a browser source that never decodes is handed to AVPlay at 4 s',
    openedH3 && AVPLAY_OPENS()[0].includes('/hang/9412')
      && handoffMs >= 3500 && handoffMs < 6000,
    `opened=${openedH3} after=${Number.isFinite(handoffMs) ? `${handoffMs}ms` : 'no request'} `
      + `url=${AVPLAY_OPENS()[0] || '(none)'}`);

  const opensBefore = AVPLAY_OPENS().length;
  press('ArrowDown', 40);
  const openedH4 = await waitFor(() => AVPLAY_OPENS().length > opensBefore, 2500);
  await sleep(300);
  const opens = AVPLAY_OPENS();
  const lastOpen = opens[opens.length - 1];
  check('H4 the next scene of that format skips the browser entirely',
    openedH4 && lastOpen.endsWith('/tone9413.wav') && !videoEl(),
    `opens=${opens.length} (was ${opensBefore}) `
      + `url=${lastOpen || '(none)'} video=${!!videoEl()}`);
}

setSettings({
  useMock: false,
  stashUrl: `http://127.0.0.1:${PORT}`,
  stashKey: 'harness',
  // A–G drive the engine directly. `Auto` (browser first) is group H's job,
  // and would never reach AVPlay for an ordinary scene.
  playbackEngine: 'tv',
});

createRoot(document.getElementById('root')).render(<Harness />);

async function run() {
  await sleep(600);
  await groupA();
  await groupB();
  await groupC();
  await groupD();
  await groupE();
  await groupF();
  await groupG();
  await groupH();
  await unmountPlayer();
}

run()
  .then(async () => {
    await fetch('/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(results, null, 2),
    });
    await fetch('/done', { method: 'POST' });
  })
  .catch(async (e) => {
    results.push({
      name: 'HARNESS CRASHED',
      pass: false,
      detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
    });
    try {
      await fetch('/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(results, null, 2),
      });
      await fetch('/done', { method: 'POST' });
    } catch { /* nothing left to do */ }
  });
