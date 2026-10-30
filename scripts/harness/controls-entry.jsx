/**
 * Headless verification driver for the player's transport rail and add-marker
 * form.
 *
 * Mounts `VideoPlayer` directly: everything under test is inside it, key
 * routing, rail and form, with the real key handler, focus registry and
 * service layer against the fake endpoint (scripts/harness/server.py). The queue
 * is a prop, so the scene, markers and duration are fixed here.
 *
 * `useKeyHandler` is mounted with a counting `onBack`: the player is a
 * capture-phase listener that calls `stopPropagation`, so only this arrangement
 * can answer "did this key reach the app".
 *
 * TV-only: whether the remote emits play/pause as 415/19/10252, and whether a
 * synthetic keydown triggers a focused button's native Space activation. It
 * does not, so only the `preventDefault` can be asserted here (R8).
 */

import { createRoot } from 'react-dom/client';
import { StrictMode, useEffect, useState } from 'react';
import VideoPlayer from '../../src/components/VideoPlayer.jsx';
import { useKeyHandler } from '../../src/hooks/useKeyHandler.js';
import { useFocusable, registry } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, ms = 3000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

const SCENE = {
  id: '4242',
  title: 'VERIFY — player controls harness',
  stream: `http://127.0.0.1:${PORT}/tone5.wav`,
  thumbnail: null,
  durationSeconds: 60,
  resume_time: 0,
};

// A one-scene queue: the ordinary case (detail-page Play, marker activation).
// `total: 1` makes `exhausted` true, which MK2's disabled buttons need.
const QUEUE = { items: [SCENE], total: 1, page: 1, startIndex: 0, startSeconds: 0 };

/**
 * The same scene three times under three titles. The title, carried in the
 * overlay's `aria-label`, is the observable: reading it proves the scene
 * changed rather than only a cursor.
 */
const threeScenes = () => ['one', 'two', 'three'].map((name, i) => ({
  ...SCENE,
  id: `4242${i}`,
  title: `VERIFY scene ${name}`,
  // A distinct URL per scene, so a step is a real source change: the
  // "inherit nothing from the outgoing playhead" rule only runs on a URL change.
  stream: `http://127.0.0.1:${PORT}/tone${i + 1}.wav`,
  // A picture per scene, so the queue drawer's rows and the near-end card can
  // be told apart by their artwork rather than by a fallback letter.
  thumbnail: `http://127.0.0.1:${PORT}/scene/${i + 1}/thumb.png`,
}));
const QUEUE3 = { items: threeScenes(), total: 3, page: 1, startIndex: 0, startSeconds: 0 };

/**
 * Played by the StrictMode probe; off QUEUE's id so its teardown save cannot be
 * read as one of the player checks' writes.
 */
const STRICT_SCENE = { ...SCENE, id: '9201', title: 'VERIFY — strict mount' };
const STRICT_QUEUE = { ...QUEUE, items: [STRICT_SCENE] };

/**
 * The real player, mounted as `src/main.jsx` mounts the app.
 *
 * StrictMode tears an effect down and mounts it again against the same refs; a
 * latch not re-armed by the effect body stays false, a dev-only failure the
 * bare-rendering drivers cannot see. Two observables cover both latches: a
 * source that never arrives, and a pause whose save is never acknowledged.
 */
function StrictProbe() {
  return <VideoPlayer queue={STRICT_QUEUE} onClose={() => {}} onActivityChange={() => {}} />;
}

async function runStrictProbe() {
  setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const strictRoot = createRoot(host);
  strictRoot.render(<StrictMode><StrictProbe /></StrictMode>);

  await waitFor(() => host.querySelector('video'), 3000);
  const loaded = await waitFor(() => {
    const el = host.querySelector('video');
    return !!el && !!el.src && el.readyState >= 1;
  }, 4000);
  const sv = host.querySelector('video');
  check('K0 the StrictMode double mount still resolves a source',
    loaded,
    `src=${JSON.stringify(sv?.src || '')} readyState=${sv?.readyState}`);

  if (loaded) {
    // A save is skipped when the position has not moved, so give it one to
    // report before pausing, the chip only exists because a write happened.
    sv.currentTime = 20;
    await waitFor(() => sv.currentTime >= 19, 2000);
    sv.pause();
    await waitFor(() => !!host.querySelector('[class*="_syncChip_"]'), 3000);
    const settled = await waitFor(
      () => /Saved|Sync failed/.test(host.querySelector('[class*="_syncChip_"]')?.textContent || ''),
      8000,
    );
    const chip = host.querySelector('[class*="_syncChip_"]')?.textContent.trim() ?? null;
    const rows = await (await fetch('/saves')).json();
    check('K1 ...and still acknowledges a save after the double mount',
      settled && chip === 'Saved',
      `chip=${JSON.stringify(chip)} saves=${JSON.stringify(rows)}`);
  }

  strictRoot.unmount();
  host.remove();
  await sleep(200);
  await fetch('/clear', { method: 'POST' });
}

/**
 * Focusables outside the player. Same registry, so "focus did not move out
 * there" proves a scope rather than an empty target.
 */
function Outside() {
  const a = useFocusable({ id: 'outside-a', zone: 'outside' });
  const b = useFocusable({ id: 'outside-b', zone: 'outside' });
  return (
    <div style={{ position: 'absolute', top: 0, left: 0 }}>
      <button ref={a.ref} style={{ display: 'block' }}>outside a</button>
      <button ref={b.ref} style={{ display: 'block' }}>outside b</button>
    </div>
  );
}

let closedCount = 0;

function Harness() {
  useKeyHandler({
    onBack: () => { window.__backSeen = (window.__backSeen || 0) + 1; },
  });

  // The queue is swapped by the stepping checks. The `key` is load-bearing:
  // `usePlayQueue` seeds `useState` from the prop once, so a different queue
  // handed to the same player would be ignored.
  const [mount, setMount] = useState({ queue: QUEUE, gen: 0 });
  useEffect(() => {
    window.__mountQueue = (queue, gen) => setMount({ queue, gen });
    window.__useThreeScenes = () => setMount({ queue: QUEUE3, gen: 1 });
  }, []);

  return (
    <>
      <Outside />
      <VideoPlayer
        key={mount.gen}
        queue={mount.queue}
        onClose={() => { closedCount++; }}
        // The completion report the App uses to prune Continue Watching; a spy
        // tests only whether the player announces it at all.
        onActivityChange={(id, patch) => {
          (window.__activity = window.__activity || []).push({ id, ...patch });
        }}
      />
    </>
  );
}

// ── Selectors ───────────────────────────────────────────────
const video = () => document.querySelector('video');
const player = () => document.querySelector('[role="dialog"][aria-label^="Now playing"]');
const rail = () => document.querySelector('[role="toolbar"]');
const modal = () => document.querySelector('[role="dialog"][aria-label="Add marker"]');
const byLabel = (label, root = document) =>
  root.querySelector(`[aria-label="${label}"]`);
const inRail = () => !!(rail() && rail().contains(document.activeElement));
const inModal = () => !!(modal() && modal().contains(document.activeElement));

/**
 * The title the player says it is showing, from the overlay's `aria-label`.
 * The queue counter comes from the hook's `index` and would pass on a cursor
 * move without a video move; the accessible name comes from the held scene.
 */
const playingTitle = () => {
  const label = player()?.getAttribute('aria-label') || '';
  return label.startsWith('Now playing: ') ? label.slice('Now playing: '.length) : null;
};

/**
 * Marker ticks, matched on the CSS-module local name (`_<local>_<hash>_<line>`).
 * Null rather than 0 when the track is missing, so a broken selector fails
 * instead of quietly reporting "no ticks".
 */
const tickCount = () => {
  if (!player()) return null;
  return player().querySelectorAll('[class*="_markerTick_"]').length;
};

/** The progress track itself, the "seek bar" ↑ is supposed to reveal. */
const progressTrack = () => player()?.querySelector('[class*="_progressTrack_"]') || null;

/** The playhead dot, positioned as a percentage of the timeline. */
const progressDot = () => player()?.querySelector('[class*="_progressDot_"]') || null;
const dotPct = () => parseFloat(progressDot()?.style.left || 'NaN');

/**
 * The controls container, found by walking up from the rail. `_controls_` does
 * not match `_controlsVisible_`; null is a failure, so a rename cannot pass.
 */
function controlsEl() {
  let el = rail() && rail().parentElement;
  while (el && el !== document.body) {
    if (typeof el.className === 'string' && el.className.includes('_controls_')) return el;
    el = el.parentElement;
  }
  return null;
}
const controlsOpacity = () => {
  const el = controlsEl();
  return el ? Number(getComputedStyle(el).opacity) : null;
};

/**
 * The player's marker-confirmation status, not the sync chip. Both carry
 * `role="status"` with the chip first, so exclude it by class, MK10 is about
 * which element announced something.
 */
const notice = () => {
  const el = [...document.querySelectorAll('[role="status"]')]
    .find(el => !modal()?.contains(el) && !String(el.className).includes('_syncChip_'));
  return el ? el.textContent.trim() : null;
};

/** The write-back chip, which is the only report a failed save makes. */
const syncChip = () => player()?.querySelector('[class*="_syncChip_"]') ?? null;
const syncText = () => syncChip()?.textContent.trim() ?? null;
const syncTitle = () => syncChip()?.getAttribute('title') ?? '';

/** The resume prompt, by its accessible name. */
const resumePrompt = () =>
  document.querySelector('[role="dialog"][aria-label="Resume playback"]');

/**
 * The modal's `role=status` line, where a failed write speaks. Found as the
 * button's sibling, so the check is that it is announced, not its wording.
 */
const modalStatus = () => modal()?.querySelector('[role="status"]')?.textContent.trim() ?? null;

const selectedChip = () => modal()?.querySelector('[aria-pressed="true"]') ?? null;
/** The form's big timestamp. `_time_` does not match `_timeRow_`. */
const formTime = () => modal()?.querySelector('[class*="_time_"]')?.textContent.trim() ?? null;
const chipLabels = () => modal()
  ? [...modal().querySelectorAll('[aria-pressed]')].map(c => c.getAttribute('aria-label'))
  : [];

/**
 * Dispatch one keydown. Enter is the default: `press(el)` without a key builds
 * `key: "undefined"`, which no handler matches, so a nudge check would pass
 * for the wrong reason. Four checks here did exactly that before the default.
 */
function press(el, key = 'Enter', keyCode = 13) {
  const e = new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  });
  (el || document.body).dispatchEvent(e);
  return e;
}

/** Enter on `document.activeElement`, the OK button on a remote. */
const ok = (el) => press(el || document.activeElement, 'Enter', 13);

const focusRailButton = (id) => registry.get(id).el.focus();

/** Release the key: a long press is press, hold, release. */
function release(key = 'Enter', keyCode = 13) {
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keyup', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}

/** OK down and up: a row that also takes a long press activates on release. */
async function tapEnter() {
  ok();
  await sleep(80);
  release();
}

/** Hold OK past the 600 ms long-press threshold, then let go. */
async function holdEnter(ms = 950) {
  ok();
  await sleep(ms);
  release();
}

const queuePanel = () => document.querySelector('[role="dialog"][aria-label="Up next"]');
const queueRows = () => (queuePanel() ? [...queuePanel().querySelectorAll('button')] : []);
const queueCount = () =>
  queuePanel()?.querySelector('[class*="_count_"]')?.textContent.trim() ?? null;
/** The near-end card (PlayerUpNextCard), by its stable marker. */
const queueHint = () => player()?.querySelector('[data-up-next]')?.textContent.trim() ?? null;
const upNextCard = () => player()?.querySelector('[data-up-next]') ?? null;
/** The controls overlay, and whether it is the visible layer. */
const controlsBar = () => player()?.querySelector('[class*="_controls_"]') ?? null;
const controlsShown = () =>
  (controlsBar()?.className || '').includes('controlsVisible');
const upNextButtons = () => (upNextCard()
  ? [...upNextCard().querySelectorAll('button')].map(b => b.textContent.trim())
  : []);

/**
 * Open the drawer and wait for the current row to take focus. That row
 * autofocuses 50 ms after it mounts; focusing another row before the timer
 * runs would be undone by it.
 */
async function openQueueSettled() {
  const opened = await waitFor(() => !!queuePanel(), 1500);
  const focused = await waitFor(() => {
    const row = queueRows().find(r => r.getAttribute('aria-current') === 'true');
    return !!row && document.activeElement === row;
  }, 1500);
  return opened && focused;
}

/**
 * The rail's clock. `currentTime` is only set from `timeupdate`, so this is
 * the visible proof the playhead the hint reads has moved; the element's own
 * `currentTime` moves without it.
 */
const clockSeconds = () => {
  const t = player()?.querySelector('[class*="_timeRow_"] [class*="_time_"]')
    ?.textContent.trim();
  if (!t) return null;
  return t.split(':').reduce((s, n) => s * 60 + Number(n), 0);
};

async function setMode(patch) {
  await fetch('/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function markerCreates() {
  const r = await fetch('/markercreates');
  return r.json();
}

async function saves() {
  const r = await fetch('/saves');
  return r.json();
}

async function playAdds() {
  const r = await fetch('/playadds');
  return r.json();
}

/** Forget every request logged so far, so a section can assert on its own. */
async function clearLogs() {
  await fetch('/clear', { method: 'POST' });
}

/**
 * Put the media element into a known play state without touching the cursor.
 * Resume checks are transition checks, so entry state must be established, not
 * inherited. Space is the mechanism under test and cursor-dependent; using it
 * to precondition would let the check agree with itself.
 */
async function setPlaying(on) {
  const v = video();
  if (!v) return;
  if (on && v.paused) { await v.play().catch(() => {}); await sleep(200); }
  if (!on && !v.paused) { v.pause(); await sleep(150); }
}

/** Seek the real element and wait for the seek to settle. */
async function seekTo(t) {
  const v = video();
  v.currentTime = t;
  await waitFor(() => Math.abs(v.currentTime - t) < 0.5, 2000);
  await sleep(40);
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

// ── The run ─────────────────────────────────────────────────
async function run() {
  setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });
  await sleep(400);

  const v = video();
  check('T0 the player mounted', !!v && !!player());
  const playing = await waitFor(() => v && !v.paused && v.readyState >= 2, 4000);
  check('T0 the media element is actually playing', playing,
    `paused=${v?.paused} readyState=${v?.readyState} duration=${v?.duration}`);
  // No saved position means nothing to ask; already playing is half the
  // evidence, since the prompt holds playback back while it is up.
  check('T0 ...and nothing interrupted it with a resume question',
    !resumePrompt(), `prompt=${!!resumePrompt()}`);
  if (!playing) { await finish(); return; }

  // ── Precondition: the controls hide on their own ────────
  // This makes R1's and R4's reveals differentials rather than claims about an
  // always-visible bar; it is the same 3 s timer R9 tests.
  await sleep(3400);
  check('P0 the controls auto-hid after ~3s', controlsOpacity() === 0,
    `opacity=${controlsOpacity()} (guard: ${controlsEl() ? 'found' : 'NOT FOUND'})`);
  const railHidden = !inRail();

  // ── R1: OK is the entry, and it lands on ⏯ ──────────────
  press(document.body, 'Enter', 13);
  await sleep(120);
  const entered = document.activeElement;
  check('R1 OK opens the rail and the controls come back',
    controlsOpacity() === 1, `opacity=${controlsOpacity()}`);
  check('R1 the cursor lands INSIDE the rail', inRail(),
    `activeElement="${(entered?.getAttribute('aria-label') || entered?.tagName)}"`);
  check('R1 the entry target is play/pause, not the leftmost button',
    entered === byLabel(playing ? 'Pause' : 'Play', rail()),
    `landed on "${entered?.getAttribute('aria-label')}" (leftmost is "Rewind 15 seconds")`);
  check('R1 setup: it really was hidden before this press', railHidden && !inRail.call(null) === false);

  // ── R2: the three-press pause, and the element that survives it ──
  // The ⏯ button must be one element: a remount would drop focus to <body> and
  // the third press would re-focus instead of resuming. Assert same node with
  // the icon changed under it.
  const ppNode = entered;
  const labelBefore = ppNode.getAttribute('aria-label');
  ok(ppNode);
  await sleep(150);
  check('R2 press 2 pauses', v.paused === true, `paused=${v.paused}`);
  check('R2 the icon flipped under the same element',
    ppNode.getAttribute('aria-label') !== labelBefore,
    `"${labelBefore}" → "${ppNode.getAttribute('aria-label')}"`);
  check('R2 focus survived the icon swap (same DOM node)',
    document.activeElement === ppNode,
    `activeElement=${document.activeElement === ppNode ? 'same node' : `"${document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.tagName}"`}`);
  ok(document.activeElement);
  await sleep(150);
  check('R2 press 3 resumes, still on the same node',
    v.paused === false && document.activeElement === ppNode,
    `paused=${v.paused}, sameNode=${document.activeElement === ppNode}`);

  // ── R10: the media keys, in both states ────────────────
  // Tizen's three: 10252 toggles, 19 is pause, 415 is play. Three separate
  // outcomes, so folding them into one toggle cannot pass. Only the TV can say
  // whether this remote emits them at all.
  await setPlaying(true);
  press(document.activeElement, 'Unidentified', 19);      // pause
  await sleep(150);
  const after19 = v.paused;
  press(document.activeElement, 'Unidentified', 19);      // again: still paused
  await sleep(150);
  const after19b = v.paused;
  press(document.activeElement, 'Unidentified', 415);     // play
  await sleep(150);
  const after415 = v.paused;
  press(document.activeElement, 'Unidentified', 415);     // again: still playing
  await sleep(150);
  const after415b = v.paused;
  press(document.activeElement, 'Unidentified', 10252);   // the one that toggles
  await sleep(150);
  check('R10 pause (19) pauses and stays paused',
    after19 === true && after19b === true, `first=${after19}, second=${after19b}`);
  check('R10 play (415) plays and stays playing',
    after415 === false && after415b === false, `first=${after415}, second=${after415b}`);
  check('R10 play/pause (10252) toggles', v.paused === true, `paused=${v.paused}`);

  // ── R6/R3: the rail's exits and entry ─────────────────────
  // Vertical keys walk a two-stop ladder: on the buttons ↓ steps and ↑ goes to
  // the seek bar; on the seek bar ↓ returns to the buttons and ↑ steps back.
  // This queue has one scene, so ↓ must leave the cursor in place; ↑ still
  // reaches the bar. Back still dismisses it (S9).
  const beforeUpTitle = playingTitle();
  press(document.activeElement, 'ArrowUp', 38);
  const upLeftWithBar = await waitFor(
    () => !inRail() && controlsOpacity() === 1 && !!progressTrack(), 1000);
  check('R6 ↑ inside the rail leaves it and keeps the seek bar up',
    upLeftWithBar,
    `inRail=${inRail()} opacity=${controlsOpacity()} track=${!!progressTrack()} activeElement="${document.activeElement?.tagName}"`);
  check('R6 ...without changing the scene', playingTitle() === beforeUpTitle,
    `"${beforeUpTitle}" → "${playingTitle()}"`);

  // OK is the way back in, landing on play/pause.
  press(document.body, 'Enter', 13);
  await sleep(140);
  check('R3 OK re-enters the rail on play/pause',
    document.activeElement === byLabel('Pause', rail()) ||
    document.activeElement === byLabel('Play', rail()),
    `activeElement="${document.activeElement?.getAttribute('aria-label')}"`);

  // ↓ from the buttons is the scene step, and this queue has only one scene:
  // the press is consumed and the cursor stays where it was. A cursor that
  // moved would mean the vertical keys were handed back to spatial nav.
  const reentered = document.activeElement;
  press(document.activeElement, 'ArrowDown', 40);
  await sleep(140);
  check('R6 ↓ on a one-scene queue does not leave the rail',
    inRail() && controlsOpacity() === 1,
    `inRail=${inRail()} opacity=${controlsOpacity()}`);
  check('R6 ...and does not move the cursor along the rail',
    document.activeElement === reentered,
    `"${reentered?.getAttribute('aria-label')}" → "${document.activeElement?.getAttribute('aria-label')}"`);
  check('R6 ...and does not change the scene', playingTitle() === beforeUpTitle,
    `"${beforeUpTitle}" → "${playingTitle()}"`);

  // OK is a no-op with the cursor already in the rail; the horizontal checks
  // below start from play/pause regardless.
  press(document.body, 'Enter', 13);
  await sleep(140);

  // ── R5: inside the rail, ←/→ move the cursor and do not seek ──
  // Horizontal nav is zone-confined, so it walks the rail; the player must not
  // also skim. The control for R4.
  await seekTo(30);
  const pp2 = byLabel('Pause', rail()) || byLabel('Play', rail());
  pp2.focus();
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(140);
  const movedTo = document.activeElement;
  check('R5 Right inside the rail moves the cursor',
    movedTo !== pp2 && inRail(),
    `"${pp2.getAttribute('aria-label')}" → "${movedTo?.getAttribute('aria-label')}"`);
  check('R5 ...and does not seek the scene',
    Math.abs(v.currentTime - 30) < 0.5, `currentTime=${v.currentTime.toFixed(2)} (was 30.0)`);

  // ── R4: from behind the rail, ←/→ skim and reveal the rail ──
  // Back is the exit here (↑ is R6's); ↓ would step from the buttons. This is
  // what the bare player does once the cursor is out of the row.
  press(document.activeElement, 'Backspace', 10009);   // leave the rail
  await sleep(3400);                              // let the controls hide again
  const hiddenAgain = controlsOpacity() === 0;
  await seekTo(30);
  press(document.body, 'ArrowRight', 39);
  await sleep(120);
  check('R4 setup: the controls were hidden before the arrow', hiddenAgain,
    `opacity=${controlsOpacity()} before`);
  check('R4 Right from behind the rail skims +5s',
    v.currentTime > 34 && v.currentTime < 36, `currentTime=${v.currentTime.toFixed(2)}`);
  check('R4 ...and reveals the rail as a hint',
    controlsOpacity() === 1, `opacity=${controlsOpacity()}`);
  check('R4 ...without taking the cursor into it', !inRail() && !inModal(),
    `activeElement="${document.activeElement?.tagName}"`);

  // ── R4b: a forward skim with no usable element duration ──
  // A Stash MP4 transcode reports none or a placeholder. `Math.min(v.duration
  // || 0, …)` made → from 50 s jump backwards to the start; bound by whichever
  // of the element and the UI timeline duration is real.
  await seekTo(50);
  Object.defineProperty(v, 'duration', { configurable: true, get: () => NaN });
  press(document.body, 'ArrowRight', 39);
  // Past the 400 ms coalescing quiet window: the press continues R4's run, so
  // its seek is deferred.
  await sleep(600);
  check('R4b a forward skim with no element duration clamps to the timeline, not to zero',
    v.currentTime > 54 && v.currentTime < 56,
    `currentTime=${v.currentTime.toFixed(2)} from 50.0 (a zero clamp lands near 0)`);
  delete v.duration;

  // ── R4c: a held skim is one seek, not one per press ─────
  // In the browser every currentTime assignment aborts the previous range
  // request, which the panel heard as heavy disk reads. A gesture now reaches
  // the element twice at most: the first press at once so a discrete tap keeps
  // its latency, and the merged final target once the presses stop.
  // Past the accel reset and past R4b's deferred seek, so this is a clean run.
  await sleep(1000);
  await seekTo(10);
  // Playing, or there is no `timeupdate` to fight the timeline: the yoyo only
  // exists while the element advances at the old position.
  await setPlaying(true);
  const nativeTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  let seekSets = 0;
  const seekMarks = [];
  const markT0 = performance.now();
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get() { return nativeTime.get.call(this); },
    set(seconds) {
      seekSets += 1;
      seekMarks.push(`${Math.round(performance.now() - markT0)}:${Number(seconds).toFixed(1)}`);
      nativeTime.set.call(this, seconds);
    },
  });
  // The accepted cadence of a held key: above the 300 ms repeat throttle. Each
  // press used to reach the element on its own; now the quiet window restarts
  // on every press and only the final target is sent.
  press(document.body, 'ArrowRight', 39);
  await sleep(350);
  press(document.body, 'ArrowRight', 39);
  // The element plays on at the old position while the target is unsent; its
  // timeupdate pulled the bar back to it, the yoyo the panel saw. Sample inside
  // the quiet window, after a tick has had time to arrive.
  await sleep(50);
  const dotAfterPress = dotPct();
  // The step glides: with no new press, 170 ms later the bar must have moved
  // toward the target rather than snapped there at once. Without the glide
  // both samples sit on the target and this fails.
  await sleep(170);
  const dotMidGlide = dotPct();
  check('R4c the target glides between held presses',
    dotMidGlide > dotAfterPress,
    `${dotAfterPress}% at 50 ms, ${dotMidGlide}% at 220 ms`);
  await sleep(230);              // ~450 ms total, still inside the quiet window
  check('R4c the timeline follows the unsent target, not the frame on screen',
    dotPct() >= dotAfterPress - 0.5, `${dotAfterPress}% then ${dotPct()}%`);
  press(document.body, 'ArrowRight', 39);
  await sleep(350);
  press(document.body, 'ArrowRight', 39);
  await sleep(750);
  check('R4c a held skim reaches the element once per gesture, not per press',
    seekSets === 2, `sets=${seekSets} over 4 presses [${seekMarks.join(', ')}]`);
  check('R4c ...and lands on the merged final target',
    v.currentTime > 25, `currentTime=${v.currentTime.toFixed(2)} from 10.0`);
  delete v.currentTime;
  // MK2's marker arithmetic assumes a still playhead; leave the state found.
  await setPlaying(false);

  // ── R11: on a lone scene, ↑/↓ raise the rail ────────────
  // With no neighbouring scene both keys were claimed and did nothing. They
  // open the transport instead; S2/S3 show they still step when there is one.
  await sleep(3400);                              // let the timers hide the rail
  check('R11 setup: the rail is hidden again', controlsOpacity() === 0,
    `opacity=${controlsOpacity()}`);
  press(document.body, 'ArrowDown', 40);
  await sleep(160);
  check('R11 ↓ on a one-scene queue raises the rail and lands on ⏯',
    controlsOpacity() === 1 && inRail()
      && document.activeElement === (byLabel('Play', rail()) || byLabel('Pause', rail())),
    `opacity=${controlsOpacity()}, activeElement="${document.activeElement?.getAttribute('aria-label')}"`);

  press(document.activeElement, 'Backspace', 10009);   // leave the rail
  await sleep(3400);                              // and let it hide again
  check('R11 setup: hidden again before ↑', controlsOpacity() === 0,
    `opacity=${controlsOpacity()}`);
  press(document.body, 'ArrowUp', 38);
  await sleep(160);
  check('R11 ↑ on a one-scene queue raises the rail too',
    controlsOpacity() === 1 && inRail(),
    `opacity=${controlsOpacity()}, activeElement="${document.activeElement?.getAttribute('aria-label')}"`);
  // Leave the cursor behind the rail, the state R8 starts from.
  press(document.activeElement, 'Backspace', 10009);
  await sleep(140);

  // ── R8: the player claims the keys it handles ───────────
  // preventDefault stops a focused <button> also firing on Space. A synthetic
  // keydown has no native activation to observe, so assert the claim itself.
  const spaceHeld = press(document.body, ' ', 32);
  await sleep(150);
  check('R8 Space is claimed from behind the rail', spaceHeld.defaultPrevented,
    `defaultPrevented=${spaceHeld.defaultPrevented}, paused=${v.paused}`);
  await seekTo(30);
  const leftHeld = press(document.body, 'ArrowLeft', 37);
  check('R8 an arrow is claimed from behind the rail', leftHeld.defaultPrevented);
  press(byLabel('Pause', rail()) || byLabel('Play', rail()), 'Enter', 13);   // rail up
  await sleep(140);
  press(document.activeElement, 'ArrowUp', 38);
  await sleep(140);
  press(document.body, 'ArrowDown', 40);
  await sleep(140);
  const spaceInRail = press(document.activeElement, ' ', 32);
  await sleep(150);
  check('R8 Space is claimed with the rail up too (no button double-fire)',
    spaceInRail.defaultPrevented, `defaultPrevented=${spaceInRail.defaultPrevented}`);

  // ── R7a: Back is "one level up", not "close the player" ─
  window.__backSeen = 0;
  const closedBefore = closedCount;
  press(document.activeElement, 'Backspace', 10009);
  await sleep(200);
  check('R7 Back inside the rail leaves the rail',
    !inRail() && closedCount === closedBefore && !!player(),
    `inRail=${inRail()} closed=${closedCount - closedBefore}`);
  check('R7 Back did not reach the App-level handler',
    window.__backSeen === 0, `App onBack fired ${window.__backSeen}×`);

  // ── MK1/MK2: the scene's markers ────────────────────────
  check('MK1 one tick per marker the scene reported', tickCount() === 3,
    `ticks=${tickCount()} (server sent 3 at 20s/40s/55s)`);

  await seekTo(30);
  focusRailButton('player-rail-marker-next');
  ok(document.activeElement);
  await sleep(150);
  check('MK2 next-marker jumps to the next marker after the cursor',
    Math.abs(v.currentTime - 40) < 0.5, `currentTime=${v.currentTime.toFixed(2)} (expected 40)`);
  ok(document.activeElement);
  await sleep(150);
  check('MK2 next-marker a second time reaches the last marker',
    Math.abs(v.currentTime - 55) < 0.5, `currentTime=${v.currentTime.toFixed(2)} (expected 55)`);
  ok(document.activeElement);
  await sleep(150);
  check('MK2 ...and running off the end does not wrap',
    Math.abs(v.currentTime - 55) < 0.5, `currentTime=${v.currentTime.toFixed(2)}`);
  focusRailButton('player-rail-marker-prev');
  ok(document.activeElement);
  await sleep(150);
  check('MK2 prev-marker steps back to the previous marker',
    Math.abs(v.currentTime - 40) < 0.5, `currentTime=${v.currentTime.toFixed(2)} (expected 40)`);

  check('MK2 a one-scene queue leaves both scene buttons un-navigable',
    byLabel('Previous scene', rail())?.disabled === true &&
    byLabel('Next scene', rail())?.disabled === true,
    `prev.disabled=${byLabel('Previous scene', rail())?.disabled}, next.disabled=${byLabel('Next scene', rail())?.disabled}`);

  // ── MK2b: the ⓘ page's marker chips jump too ────────────
  // The player renders SceneDetailPage without `onPlayAt`, so its chips were
  // focus stops that consumed OK and did nothing. The fake serves this marker
  // inside the 60 s tone (`sceneMarkers: early`): the detail markers at
  // 125/640/1905 s clamp to the end, where a jump looks like a no-op.
  await setMode({ sceneMarkers: 'early' });
  await seekTo(30);
  focusRailButton('player-rail-details');
  ok(document.activeElement);
  const chipAppeared = await waitFor(() => registry.get('scene-marker-905'), 3000);
  check('MK2b the player\'s detail page renders its marker chips', chipAppeared,
    `registry has ${!!registry.get('scene-marker-905')}`);
  const chip = registry.get('scene-marker-905');
  if (chip) {
    chip.el.focus();
    await sleep(80);
    press(chip.el, 'Enter', 13);
    await sleep(400);
    check('MK2b OK on a chip closes the detail page',
      !document.contains(chip.el), 'the overlay unmounted');
    check('MK2b ...and seeks the playing scene to the marker',
      Math.abs(v.currentTime - 12) < 1.5,
      `currentTime=${v.currentTime.toFixed(2)} (expected 12)`);
    check('MK2b ...and resumes playback', v.paused === false, `paused=${v.paused}`);
  } else {
    check('MK2b OK on a chip closes the detail page', false, 'no chip');
    check('MK2b ...and seeks the playing scene to the marker', false, 'no chip');
    check('MK2b ...and resumes playback', false, 'no chip');
  }
  await setMode({ sceneMarkers: 'ok' });

  // ── MK3: the form opens, and pauses what it covers ───────
  // The scene is playing first: MK10's hand-back claim needs it.
  await seekTo(30.7);
  await setPlaying(true);
  check('MK3 setup: the scene is playing before the form opens', v.paused === false,
    `paused=${v.paused}`);
  focusRailButton('player-rail-marker-add');
  ok(document.activeElement);
  await sleep(400);   // the tag fetch
  check('MK3 OK on add-marker opens the form', !!modal());
  check('MK3 opening the form pauses the scene', v.paused === true, `paused=${v.paused}`);
  // The captured second is held, not hardcoded: it depends on how long the
  // press took. MK9 asserts the nudge as a difference, not an absolute.
  const formOpenedAt = v.currentTime;
  check('MK3 the cursor moved into the form', inModal(),
    `activeElement="${document.activeElement?.getAttribute('aria-label')}"`);

  // ── MK5: the recent row, in the order the server gave ────
  // (C, B) is no slice of the library listing, so a library row cannot match
  // by coincidence. Exact labels: the recent chips carry no count.
  check('MK5 the recent row is shown', modal().textContent.includes('Recently used'));
  check('MK5 ...in the server\'s recency order, not the library\'s',
    chipLabels().slice(0, 2).join(' | ') === 'Harness Tag C | Harness Tag B',
    `first chips: ${chipLabels().slice(0, 3).join(' | ')}`);

  // ── MK6: the default tag is this scene's, not the library's ──
  // Library-most-used C leads the tag row; this scene's markers use A twice.
  // Opening on C would file the marker under a tag this scene never used.
  check('MK6 the form opens on the scene\'s own most-used tag',
    selectedChip()?.getAttribute('aria-label') === 'Harness Tag A, 40 markers',
    `selected="${selectedChip()?.getAttribute('aria-label')}"`);
  check('MK6 ...and not on the library\'s most-used tag',
    byLabel('Harness Tag C, 268 markers', modal())?.getAttribute('aria-pressed') === 'false',
    `C pressed=${byLabel('Harness Tag C, 268 markers', modal())?.getAttribute('aria-pressed')}`);
  check('MK6 ...which is nonetheless offered in the tag row',
    !!byLabel('Harness Tag C, 268 markers', modal()));

  // ── MK8: the player yields every key while the form is up ──
  await seekTo(30.7);
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(140);
  check('MK8 an arrow while the form is up does not seek the scene',
    Math.abs(v.currentTime - 30.7) < 0.5, `currentTime=${v.currentTime.toFixed(2)} (was 30.7)`);
  check('MK8 the controls stayed hidden behind the form',
    controlsOpacity() === 1, 'the form draws its own panel; this is the player not acting');

  // ── MK4: the nudge moves the form's number, not the playhead ──
  // Both halves: "the playhead did not move" alone passes on a nudge that
  // never fired, which is how this passed while the buttons were dead.
  const timeBefore = formTime();
  press(byLabel('Back 5 seconds', modal()));
  await sleep(120);
  check('MK4 the nudge moves the form\'s own timestamp',
    formTime() !== timeBefore && formTime() !== null,
    `${timeBefore} → ${formTime()}`);
  check('MK4 ...and leaves the playhead alone',
    Math.abs(v.currentTime - 30.7) < 0.5, `currentTime=${v.currentTime.toFixed(2)}`);
  // MK9 asserts the nudge reached the write rather than only the display: the
  // posted second is 30.7 − 5, not 30.7.

  // ── MK11: a failed write keeps the form ──────────────────
  // Pressed from the button itself: while the write is in flight it is
  // `aria-disabled`, not native, so the cursor must survive the round trip.
  await setMode({ markerCreate: 'fail' });
  const saveBtn = byLabel('Add marker', modal());
  saveBtn.focus();
  await sleep(80);
  press(saveBtn);
  await sleep(600);
  check('MK11 a failed create keeps the form open', !!modal());
  check('MK11 ...and the cursor stays on the button it was pressed from',
    document.activeElement === byLabel('Add marker', modal()),
    `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);
  check('MK11 ...and says why, in the announced line',
    /could not save/i.test(modalStatus() || ''), `status="${modalStatus()}"`);
  check('MK11 ...and keeps the chosen tag',
    selectedChip()?.getAttribute('aria-label') === 'Harness Tag A, 40 markers',
    `selected="${selectedChip()?.getAttribute('aria-label')}"`);
  check('MK11 ...and keeps the scene paused', v.paused === true, `paused=${v.paused}`);
  await setMode({ markerCreate: 'ok' });

  // ── MK9/MK10: the write itself ──────────────────────────
  const ticksBefore = tickCount();
  press(byLabel('Add marker', modal()));
  await sleep(700);
  const creates = await markerCreates();
  const posted = creates[creates.length - 1];
  check('MK9 the created marker carries the scene, the nudged second and the tag',
    posted && posted.scene_id === '4242' &&
    Math.abs(Number(posted.seconds) - (formOpenedAt - 5)) < 0.05 &&
    posted.primary_tag_id === '9001' &&
    posted.end_seconds === null,
    `posted ${JSON.stringify(posted)} — form opened at ${formOpenedAt.toFixed(2)}, so the ` +
    'nudged marker belongs at that minus 5');
  check('MK9 an empty label falls back to the tag\'s name',
    posted?.title === 'Harness Tag A', `title="${posted?.title}"`);
  check('MK10 a successful create closes the form', !modal());
  check('MK10 ...adds a tick for the new marker', tickCount() === ticksBefore + 1,
    `ticks ${ticksBefore} → ${tickCount()}`);
  check('MK10 ...confirms it on screen',
    /marker added/i.test(notice() || ''), `notice="${notice()}"`);
  check('MK10 ...and resumes the scene the form interrupted', v.paused === false,
    `paused=${v.paused}`);

  // ── MK12: the form is not a play button ─────────────────
  // A scene paused before the form opened stays paused. Same input, opposite
  // outcome from MK10, so its resume is meaningful.
  await setPlaying(false);
  check('MK12 setup: the scene is paused before the form opens', v.paused === true);
  focusRailButton('player-rail-marker-add');
  ok(document.activeElement);
  await sleep(400);
  press(byLabel('Cancel', modal()));
  await sleep(300);
  check('MK12 Cancel closes the form', !modal());
  check('MK12 ...and does not start a scene that was paused',
    v.paused === true, `paused=${v.paused}`);

  // ── MK4b: the nudge at its bound keeps the cursor ────────
  // The form opens on the playhead, and the scene is at most a minute long, so
  // twelve presses reach 0. Reaching the bound used to natively disable the
  // pressed button and drop the cursor to <body> mid-gesture.
  focusRailButton('player-rail-marker-add');
  ok(document.activeElement);
  await sleep(400);
  const backNudge = byLabel('Back 5 seconds', modal());
  backNudge.focus();
  await sleep(60);
  for (let i = 0; i < 12; i++) {
    press(backNudge);
    await sleep(60);
  }
  check('MK4b nudging to the start holds the form at 00:00',
    formTime() === '00:00', `formTime=${formTime()}`);
  check('MK4b ...and keeps the cursor on the nudge button, muted',
    document.activeElement === byLabel('Back 5 seconds', modal())
      && byLabel('Back 5 seconds', modal())?.getAttribute('aria-disabled') === 'true',
    `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);
  press(byLabel('Cancel', modal()));
  await sleep(300);

  // ── MK7: Back out of the form, and where the cursor goes ──
  focusRailButton('player-rail-marker-add');
  ok(document.activeElement);
  await sleep(400);
  window.__backSeen = 0;
  const closedBeforeForm = closedCount;
  press(document.activeElement, 'Backspace', 10009);
  await sleep(300);
  check('MK7 Back closes the form', !modal());
  check('MK7 ...without closing the player', closedCount === closedBeforeForm && !!player(),
    `closed=${closedCount - closedBeforeForm}`);
  check('MK7 ...without reaching the App-level handler',
    window.__backSeen === 0, `App onBack fired ${window.__backSeen}×`);
  // The opener must regain focus; the rail's auto-hide refuses to run while it
  // holds focus, so this also proves the cursor did not land on <body>.
  check('MK7 ...and the cursor returns to the button that opened it',
    document.activeElement === byLabel('Add marker', rail()),
    `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);

  // ── D1–D4: the detail page over the player ───────────────
  // The player renders the page itself, so no App is needed. Its `scene` prop
  // comes from the player, and its own `findScene` gets the same SCENE from the
  // fake's `FindSceneDetail`.
  const detailsPage = () => [...document.querySelectorAll('[role="dialog"]')]
    .find(el => el !== player() && el !== modal()) ?? null;
  // By registry id, not accessible name: the page's ActionButtons carry no
  // `aria-label`, and the registry is the deterministic handle used throughout.
  const scenePlay = () => registry.get('scene-play')?.el ?? null;

  await seekTo(30);
  if (v.paused) { press(document.body, ' ', 32); await sleep(150); }   // ensure playing
  const detailsBtn = byLabel('Details', rail());
  check('D1 the ⓘ button is live (it was shipped disabled while unwired)', !detailsBtn.disabled,
    `disabled=${detailsBtn.disabled}`);
  detailsBtn.focus();
  ok(detailsBtn);
  await sleep(600);   // the page's own detail fetch
  check('D1 OK on ⓘ opens the detail page', !!detailsPage());
  check('D1 ...and pauses the scene behind it', v.paused === true, `paused=${v.paused}`);
  check('D1 ...with the cursor inside it, on Play', document.activeElement === scenePlay(),
    `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);

  // The player must own nothing while the page is up. Same key and cursor
  // position as R4, where it skimmed, so this is a yield, not a missing binding.
  await seekTo(30);
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(140);
  check('D2 an arrow over the page does not skim the scene',
    Math.abs(v.currentTime - 30) < 0.5, `currentTime=${v.currentTime.toFixed(2)} (was 30.0)`);
  const spaceOverPage = press(document.body, ' ', 32);
  await sleep(150);
  check('D2 ...and Space does not reach the player either',
    v.paused === true && !spaceOverPage.defaultPrevented,
    `paused=${v.paused}, claimed=${spaceOverPage.defaultPrevented}`);

  // Back closes the page and the cursor must return, or the rail auto-hides
  // and the returned-to button is invisible.
  press(document.activeElement, 'Backspace', 10009);
  await sleep(300);
  check('D3 Back closes the page', !detailsPage());
  check('D3 ...and the cursor returns to the ⓘ that opened it',
    document.activeElement === byLabel('Details', rail()),
    `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);
  check('D3 ...and the scene stays paused (no auto-resume)', v.paused === true,
    `paused=${v.paused}`);

  // D4 is D3's control: same page, close and entry state, only the button
  // differs, so D3's "still paused" cannot come from a page unable to resume.
  ok(document.activeElement);
  await sleep(600);
  check('D4 setup: the page is open again, on the same paused scene',
    !!detailsPage() && v.paused === true, `paused=${v.paused}`);
  press(scenePlay());
  await sleep(400);
  check('D4 Play on the page closes it and resumes the scene',
    !detailsPage() && v.paused === false, `open=${!!detailsPage()} paused=${v.paused}`);
  check('D4 ...without restarting it from zero', v.currentTime > 25,
    `currentTime=${v.currentTime.toFixed(2)} (the page must not rebuild the session)`);

  // ── R7b: Back puts the controls away before it closes the player ──
  // After D4 the bar is up (Play on the ⓘ page calls `showControls`) with the
  // cursor behind it: one Back hides the bar, the next closes the player.
  document.activeElement?.blur?.();
  await sleep(120);
  check('R7 setup: the bar is up, the cursor is off the rail and no page is up',
    controlsOpacity() === 1 && !inRail() && !detailsPage() && !modal(),
    `opacity=${controlsOpacity()} inRail=${inRail()} page=${!!detailsPage()} form=${!!modal()}`);
  const closedMid = closedCount;
  press(document.body, 'Backspace', 10009);
  const hidBar = await waitFor(() => controlsOpacity() === 0, 1000);
  check('R7 Back with the bar up hides it and leaves the player open',
    hidBar && closedCount === closedMid,
    `opacity=${controlsOpacity()} closed += ${closedCount - closedMid}`);
  check('R7 ...and still never reached the App-level handler',
    window.__backSeen === 0, `App onBack fired ${window.__backSeen}×`);
  press(document.body, 'Backspace', 10009);
  await sleep(250);
  check('R7 the Back after that closes the player', closedCount === closedMid + 1,
    `closed += ${closedCount - closedMid}`);

  // ── S: ↑/↓ step scenes, in every state ───────────────────
  // Above ran on a one-scene queue, so the scene keys were indistinguishable
  // from dead ones. Replace the player with a three-scene queue (hence `key`).
  window.__useThreeScenes();
  await sleep(900);
  check('S1 setup: a three-scene queue, on scene one, rail down',
    playingTitle() === 'VERIFY scene one' && !inRail() && !modal() && !detailsPage(),
    `title="${playingTitle()}" inRail=${inRail()}`);
  // The remount starts with the bar up, so hide it: hidden is the resting
  // state the first press tests.
  if (controlsOpacity() !== 0) {
    press(document.body, 'Backspace', 10009);
    await waitFor(() => controlsOpacity() === 0, 1000);
  }
  check('S1 setup: the bar is hidden', controlsOpacity() === 0,
    `opacity=${controlsOpacity()} closed=${closedCount}`);

  press(document.body, 'ArrowDown', 40);
  await sleep(500);
  check('S2 ↓ steps to the next scene with the rail down',
    playingTitle() === 'VERIFY scene two', `title="${playingTitle()}"`);

  // The step showed the controls, so the cursor is on the seek bar; ↑ there is
  // the scene step (the seek bar is the ladder's lower stop).
  check('S3 setup: the step showed the bar', controlsOpacity() === 1,
    `opacity=${controlsOpacity()}`);
  press(document.body, 'ArrowUp', 38);
  await sleep(900);
  check('S3 ↑ from the seek bar steps back to the previous scene',
    playingTitle() === 'VERIFY scene one', `title="${playingTitle()}"`);

  // ── S3b: the outgoing playhead is not inherited ──────────
  // A fallback source reloads the same scene and resumes; a different scene
  // starts from its resume decision, never the previous clock. Both share one
  // ref, so the discriminator is the scene id captured with the time.
  // The cursor is on the seek bar: ↓ returns to the buttons without stepping,
  // the next ↓ steps.
  await seekTo(25);
  await sleep(400);            // let a save settle so it cannot be mistaken for the seek
  press(document.body, 'ArrowDown', 40);
  await sleep(250);
  check('S3b setup: ↓ from the seek bar returns to the buttons without stepping',
    inRail() && playingTitle() === 'VERIFY scene one',
    `inRail=${inRail()} title="${playingTitle()}"`);
  press(document.activeElement, 'ArrowDown', 40);
  await sleep(900);            // the new URL loads and its metadata arrives
  await waitFor(() => (video()?.currentTime || 0) < 5, 2500);
  check('S3b stepping to the next scene starts it at the beginning, not at the ' +
    'previous scene\'s playhead',
    playingTitle() === 'VERIFY scene two' && (video()?.currentTime || 0) < 5,
    `title="${playingTitle()}" currentTime=${video()?.currentTime?.toFixed(1)} ` +
    '(the outgoing scene was at 25 s)');
  // Back to scene one for S4. The cursor is on the buttons: ↑ is the exit to
  // the seek bar, and the seek bar's ↑ then steps back.
  press(document.activeElement, 'ArrowUp', 38);
  await sleep(250);
  press(document.body, 'ArrowUp', 38);
  await sleep(900);
  check('S4 setup: back on scene one, cursor off the rail',
    playingTitle() === 'VERIFY scene one' && !inRail(),
    `title="${playingTitle()}" inRail=${inRail()}`);

  // Two-stop ladder: on the buttons ↓ steps in one press; on the seek bar ↓
  // returns to the buttons first. ↑ mirrors it. The entry target is play/pause,
  // the one rail button never disabled.
  press(document.body, 'Enter', 13);
  await sleep(350);
  check('S4 the rail is up with the cursor in it',
    inRail() && document.activeElement === registry.get('player-rail-playpause')?.el,
    `inRail=${inRail()} el=${document.activeElement?.getAttribute('aria-label')}`);

  press(document.activeElement, 'ArrowDown', 40);
  await sleep(900);
  check('S5 ↓ from the buttons steps to the next scene in one press',
    playingTitle() === 'VERIFY scene two',
    `title="${playingTitle()}" inRail=${inRail()}`);

  // ↑ from the buttons is the seek-bar stop, not a step: the scene stays put
  // and the cursor leaves the row with the bar still up.
  const beforeSeek = playingTitle();
  press(document.activeElement, 'ArrowUp', 38);
  const seekUp = await waitFor(
    () => !inRail() && controlsOpacity() === 1 && !!progressTrack(), 1000);
  check('S5b ↑ from the buttons leaves for the seek bar without stepping',
    seekUp && playingTitle() === beforeSeek,
    `inRail=${inRail()} opacity=${controlsOpacity()} track=${!!progressTrack()} "${beforeSeek}" → "${playingTitle()}"`);

  press(document.body, 'ArrowDown', 40);
  const backToControls = await waitFor(() => inRail(), 1000);
  check('S6 ↓ from the seek bar returns to the buttons without stepping',
    backToControls && playingTitle() === beforeSeek,
    `inRail=${inRail()} "${beforeSeek}" → "${playingTitle()}"`);

  press(document.activeElement, 'ArrowDown', 40);
  await sleep(900);
  check('S6b ↓ from the buttons now steps to the next scene',
    playingTitle() === 'VERIFY scene three', `title="${playingTitle()}"`);

  check('S7 setup: the one-press ladder reached the last scene',
    playingTitle() === 'VERIFY scene three', `title="${playingTitle()}"`);

  press(document.activeElement, 'ArrowDown', 40);
  await sleep(500);
  check('S8 ↓ at the end of the queue does not wrap',
    playingTitle() === 'VERIFY scene three', `title="${playingTitle()}"`);

  press(document.body, 'Enter', 13);
  await sleep(350);
  const closedBeforeRailBack = closedCount;
  check('S9 setup: the rail is up again', inRail(),
    `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);
  press(document.activeElement, 'Backspace', 10009);
  const leftAndHid = await waitFor(() => !inRail() && controlsOpacity() === 0, 1000);
  check('S9 Back with the rail up leaves the rail, hides the bar and not the player',
    leftAndHid && closedCount === closedBeforeRailBack,
    `inRail=${inRail()} opacity=${controlsOpacity()} closed += ${closedCount - closedBeforeRailBack}`);

  // S10 keeps S9's hide from being the auto-hide timer: S9 waits one second,
  // short of the 3 s delay. After the delay, nothing may re-show the bar or
  // close the player.
  check('S10 the bar is down at once, not after a timer',
    controlsOpacity() === 0, `opacity=${controlsOpacity()} immediately after Back`);
  await sleep(3400);
  check('S10 ...and no timer brings it back or closes the player',
    controlsOpacity() === 0 && closedCount === closedBeforeRailBack,
    `opacity=${controlsOpacity()} closed += ${closedCount - closedBeforeRailBack}`);

  // ── Q: the queue drawer ──────────────────────────────────
  // Still the three-scene queue, now on the last scene. The drawer is a dialog
  // over the player: its rows are the only stops, Back closes it without
  // touching the player, and the near-end hint is the non-interactive half.
  const closedBeforeQueue = closedCount;
  check('Q1 the rail offers "Up next" on a multi-scene queue',
    !!byLabel('Up next', rail()) && !!registry.get('player-rail-queue'),
    `rail ${!!rail()} button ${!!byLabel('Up next', rail())}`);

  press(document.body, 'Enter', 13);
  await sleep(350);
  focusRailButton('player-rail-queue');
  await sleep(80);
  ok();
  const queueOpened = await openQueueSettled();
  check('Q2 OK on it opens the drawer', queueOpened,
    `open ${!!queuePanel()} focus "${document.activeElement?.getAttribute('aria-label')}"`);

  const openedRows = queueRows();
  check('Q2b it lists the session, marks the scene on screen and starts there',
    openedRows.length === 3
      && queueCount() === '3 of 3'
      && openedRows[2]?.getAttribute('aria-current') === 'true'
      && document.activeElement === openedRows[2],
    `rows=${openedRows.length} count=${queueCount()} `
      + `current=${openedRows[2]?.getAttribute('aria-current')} `
      + `focused="${document.activeElement?.getAttribute('aria-label')}"`);

  press(document.activeElement, 'Backspace', 10009);
  const drawerClosed = await waitFor(() => !queuePanel(), 1500);
  await sleep(120);
  check('Q3 Back closes the drawer, not the player, and lands on its button',
    drawerClosed && closedCount === closedBeforeQueue
      && document.activeElement === registry.get('player-rail-queue')?.el,
    `open ${!!queuePanel()} closed += ${closedCount - closedBeforeQueue} `
      + `focus "${document.activeElement?.getAttribute('aria-label')}"`);

  ok();
  await openQueueSettled();
  queueRows()[0]?.focus();
  await sleep(80);
  await holdEnter();
  await sleep(200);
  const afterRemove = queueRows();
  check('Q4 holding OK on a row removes it and moves the cursor to the next one',
    afterRemove.length === 2
      && queueCount() === '2 of 2'
      && afterRemove[0]?.getAttribute('aria-label') === 'VERIFY scene two'
      && document.activeElement === afterRemove[0],
    `rows=${afterRemove.length} count=${queueCount()} `
      + `first="${afterRemove[0]?.getAttribute('aria-label')}" `
      + `focused="${document.activeElement?.getAttribute('aria-label')}"`);

  // The scene on screen has no removal: Next is how you skip it. The row has
  // no long press, so the gesture is a tap and the drawer closes.
  queueRows()[1]?.focus();
  await sleep(80);
  await holdEnter();
  await sleep(200);
  const closedByTap = !queuePanel();
  if (closedByTap) {
    ok();
    await openQueueSettled();
  }
  const afterCurrent = queueRows();
  check('Q5 the scene on screen cannot be removed by the same hold',
    closedByTap && playingTitle() === 'VERIFY scene three'
      && afterCurrent.length === 2
      && afterCurrent[1]?.getAttribute('aria-current') === 'true',
    `closed=${closedByTap} title="${playingTitle()}" rows=${afterCurrent.length} `
      + `current=${afterCurrent[1]?.getAttribute('aria-current')}`);

  const rowZero = queueRows()[0];
  rowZero?.focus();
  await sleep(80);
  const focusBeforeJump = document.activeElement?.getAttribute('aria-label');
  await tapEnter();
  const jumped = await waitFor(() => playingTitle() === 'VERIFY scene two', 3000);
  await sleep(200);
  check('Q6 OK on a row jumps to it, closes the drawer and returns to its button',
    jumped && !queuePanel() && closedCount === closedBeforeQueue
      && document.activeElement === registry.get('player-rail-queue')?.el,
    `title="${playingTitle()}" open ${!!queuePanel()} `
      + `focus "${document.activeElement?.getAttribute('aria-label')}" `
      + `| row0="${rowZero?.getAttribute('aria-label')}" `
      + `beforePress="${focusBeforeJump}"`);

  await waitFor(() => (video()?.duration || 0) > 0, 3000);
  await setPlaying(false);
  check('Q7 no hint at the start of a scene, even with one queued next',
    queueHint() === null && clockSeconds() !== null,
    `hint=${JSON.stringify(queueHint())} clock=${clockSeconds()}`);

  // The key hint names the step in force, not a hardcoded 15 s. Adaptive's
  // first rung is what one press gives.
  const keyHint = player()?.querySelector('[class*="_hint_"]')?.textContent || '';
  check('Q7a the key hint names the step in force',
    /−5s/.test(keyHint) && /\+5s/.test(keyHint),
    `hint ${JSON.stringify(keyHint.trim())}`);

  // The clock state is fed by `timeupdate`, so the seek has to land while the
  // element is playing; a paused seek moves the element and not the UI.
  const queuedDuration = video()?.duration || 0;
  const queuedTarget = Math.max(0, queuedDuration - 12);
  await setPlaying(true);
  await seekTo(queuedTarget);
  const hintShown = await waitFor(() => !!queueHint(), 2500);
  check('Q7b near the end the hint names the next scene',
    hintShown && queueHint().includes('Up next')
      && queueHint().includes('VERIFY scene three')
      && Math.abs((clockSeconds() ?? -99) - queuedTarget) <= 2,
    `hint=${JSON.stringify(queueHint())} clock=${clockSeconds()} `
      + `target=${queuedTarget.toFixed(0)}/${queuedDuration.toFixed(0)}s`);
  await setPlaying(false);

  // The card carries the next scene's picture, title and countdown, and it
  // takes the cursor when it appears: the remote answers Play now and Hide
  // without a press to get in. The controls behind it go down with it, so
  // there is one offer and one set of keys on screen.
  const card = upNextCard();
  const cardImg = card?.querySelector('img');
  const cardText = card?.textContent || '';
  const cardTookFocus = await waitFor(
    () => document.activeElement === registry.get('upnext-play')?.el, 1500);
  check('Q7d the card shows the next scene\'s picture, title and countdown, and takes the cursor',
    !!card && (cardImg?.getAttribute('src') || '').includes('/scene/3/thumb.png')
      && cardText.includes('VERIFY scene three')
      && /Next in \d+ s/.test(cardText)
      && upNextButtons().join('/') === 'Play now/Hide'
      && cardTookFocus,
    `img=${cardImg?.getAttribute('src')} buttons=${JSON.stringify(upNextButtons())} `
      + `focus=${cardTookFocus} text=${JSON.stringify(cardText.slice(0, 80))}`);
  // Ask for the bar the way a viewer would (a mousemove is the activity path),
  // so the check below is not a bar that happened to have timed out already.
  player().dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  await sleep(120);
  check('Q7d2 the controls stay down while the card is up',
    !!card && !controlsShown(),
    `card=${!!card} controls=${controlsShown()} className="${controlsBar()?.className}"`);

  // ←/→ walk the two buttons, ↑ has nowhere to go, and Back puts the card away
  // the same as Hide: the scene carries on and the rail takes the cursor.
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(120);
  const walked = document.activeElement === registry.get('upnext-hide')?.el;
  press(document.activeElement, 'ArrowLeft', 37);
  await sleep(120);
  const walkedBack = document.activeElement === registry.get('upnext-play')?.el;
  press(document.activeElement, 'ArrowUp', 38);
  await sleep(120);
  const topStop = document.activeElement === registry.get('upnext-play')?.el;
  press(document.activeElement, 'Escape', 27);
  const dismissed = await waitFor(() => !upNextCard(), 1500);
  const railRestored = await waitFor(
    () => document.activeElement === registry.get('player-rail-playpause')?.el, 1500);
  // The same mechanism must be able to show the bar again, or Q7d2 would pass
  // on a player whose controls never appear at all.
  const barBack = await waitFor(() => controlsShown(), 1500);
  check('Q7e ←/→ walk the card\'s buttons, ↑ stays put and Back puts the card away',
    walked && walkedBack && topStop && dismissed && railRestored && barBack
      && playingTitle() === 'VERIFY scene two',
    `right=${walked} left=${walkedBack} up=${topStop} dismissed=${dismissed} `
      + `rail=${railRestored} bar=${barBack} title="${playingTitle()}"`);

  press(document.body, 'Enter', 13);
  await sleep(350);
  focusRailButton('player-rail-queue');
  await sleep(80);
  ok();
  const drawerForHint = await openQueueSettled();
  check('Q7c the hint yields to the drawer',
    drawerForHint && queueHint() === null,
    `hint=${JSON.stringify(queueHint())} open ${!!queuePanel()} `
      + `focus "${document.activeElement?.getAttribute('aria-label')}"`);

  // Ensure the drawer is up rather than assume Q7c left it: a row press here
  // silently no-ops when the panel is closed and the check fails elsewhere.
  if (!queuePanel()) {
    focusRailButton('player-rail-queue');
    await sleep(80);
    ok();
    await openQueueSettled();
  }
  const lastRow = queueRows().find(r => r.getAttribute('aria-current') !== 'true');
  lastRow?.focus();
  await sleep(80);
  await tapEnter();
  const reachedLast = await waitFor(() => playingTitle() === 'VERIFY scene three', 3000);
  await waitFor(() => (video()?.duration || 0) > 0, 3000);
  await waitFor(() => (video()?.duration || 0) > 0, 3000);
  const lastDuration = video()?.duration || 0;
  const lastTarget = Math.max(0, lastDuration - 12);
  await setPlaying(true);
  await seekTo(lastTarget);
  const clockMoved = await waitFor(
    () => Math.abs((clockSeconds() ?? -99) - lastTarget) <= 2, 2500);
  await setPlaying(false);
  check('Q8 the last scene of the queue has no hint',
    reachedLast && clockMoved && queueHint() === null
      && playingTitle() === 'VERIFY scene three',
    `hint=${JSON.stringify(queueHint())} clock=${clockSeconds()} `
      + `moved=${clockMoved} reached=${reachedLast} title="${playingTitle()}"`);

  // ── Q9: the card's two buttons ───────────────────────────
  // Hide puts only this scene's card away; the queue still advances when the
  // scene ends, so the check is that the scene is unchanged and the picture is
  // still moving. Play now skips the wait. One mount each: a hide belongs to
  // the scene it was pressed on, so the second mount is a fresh offer.
  const CARD_QUEUE = {
    items: threeScenes().slice(1), total: 2, page: 1, startIndex: 0, startSeconds: 0,
  };
  const openCardOffer = async (gen) => {
    window.__mountQueue(CARD_QUEUE, gen);
    await waitFor(() => (video()?.duration || 0) > 0, 4000);
    await sleep(300);
    const d = video()?.duration || 0;
    await setPlaying(true);
    await seekTo(Math.max(0, d - 8));
    const shown = await waitFor(() => !!upNextCard(), 3000);
    // A fresh mount focuses the card itself; no key is needed to get in.
    const focused = await waitFor(
      () => document.activeElement === registry.get('upnext-play')?.el, 1500);
    return shown && focused;
  };

  const hideShown = await openCardOffer(11);
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(120);
  const hideFocused = document.activeElement === registry.get('upnext-hide')?.el;
  const timeBeforeHide = video()?.currentTime ?? 0;
  ok();
  const hidden = await waitFor(() => !upNextCard(), 1500);
  await sleep(400);
  const stillMoving = (video()?.currentTime ?? 0) > timeBeforeHide;
  await setPlaying(false);
  check('Q9 Hide puts the card away and the scene carries on',
    hideShown && hideFocused && hidden && stillMoving
      && playingTitle() === 'VERIFY scene two'
      && document.activeElement === registry.get('player-rail-playpause')?.el,
    `shown=${hideShown} hideFocus=${hideFocused} hidden=${hidden} `
      + `moving=${stillMoving} title="${playingTitle()}" `
      + `focus="${document.activeElement?.getAttribute('aria-label')}"`);

  const playShown = await openCardOffer(12);
  const playFocused = document.activeElement === registry.get('upnext-play')?.el;
  ok();
  const skipped = await waitFor(() => playingTitle() === 'VERIFY scene three', 3000);
  const railBack = await waitFor(
    () => document.activeElement === registry.get('player-rail-playpause')?.el, 1500);
  await sleep(200);
  check('Q9a Play now moves to the next scene and hands the cursor back to the rail',
    playShown && playFocused && skipped && railBack && !upNextCard(),
    `shown=${playShown} playFocus=${playFocused} skipped=${skipped} rail=${railBack} `
      + `card=${!!upNextCard()} title="${playingTitle()}"`);

  // ── W: what the player writes back ───────────────────────
  // Two unrelated contracts. The play count is a request count (`sceneAddPlay`
  // appends a row), visible only in the log: firing on every stall or resume
  // would still leave a plausible total. `play_duration` is a sum of deltas,
  // so its failure is inflation: after a 30 s seek, reporting the position as
  // duration would be wrong by an order of magnitude. A fresh player, because
  // both counters are per-session refs.
  const PLAY_SCENE = {
    ...SCENE,
    id: '9090',
    title: 'VERIFY — write-back harness',
    stream: `http://127.0.0.1:${PORT}/tone3.wav`,
    resume_time: 0,
  };
  const PQ = { items: [PLAY_SCENE], total: 1, page: 1, startIndex: 0, startSeconds: 0 };

  await setMode({ resume: 0, save: 'ok', sceneAddPlay: 'ok' });
  await clearLogs();
  window.__mountQueue(PQ, 3);
  await sleep(1200);
  const pv = video();
  check('W0 setup: a fresh session on an unwatched scene is playing',
    !!pv && pv.paused === false && playingTitle() === 'VERIFY — write-back harness',
    `title="${playingTitle()}" paused=${pv?.paused}`);
  check('Q9 a one-scene queue has no "Up next" button',
    !byLabel('Up next', rail()),
    `button ${!!byLabel('Up next', rail())}`);
  await sleep(500);

  // Pause, resume, pause, seek, play: each transition is a separate `play`
  // event and save, making "exactly once" an assertion, not a restatement.
  await setPlaying(false);
  await setPlaying(true);
  await setPlaying(false);
  await seekTo(0);
  await setPlaying(true);
  await sleep(500);

  const adds = await playAdds();
  check('W1 a scene played, paused, resumed and skimmed is counted exactly once',
    adds.length === 1 && adds[0].id === '9090',
    `${adds.length} sceneAddPlay call(s): ${JSON.stringify(adds)} — once per session, ` +
    'not once per play event and not once per save');
  check('W2 ...with one explicit timestamp rather than a null "now"',
    Array.isArray(adds[0]?.times) && adds[0].times.length === 1 &&
      !Number.isNaN(Date.parse(adds[0].times[0])),
    `times=${JSON.stringify(adds[0]?.times)} — the column is scenes_view_dates, one ` +
    'row per entry, so the count is the length of what gets sent');

  // The skim: 30 unwatched seconds in one step. A position-as-duration bug
  // would report this as half a minute of viewing.
  await setPlaying(false);
  await seekTo(30);
  await setPlaying(true);
  await sleep(2500);
  await setPlaying(false);
  await sleep(500);

  const rows = (await saves()).filter(s => s.id === '9090');
  const watched = rows.reduce((a, s) => a + (Number(s.playDuration) || 0), 0);
  const furthest = rows.reduce((a, s) => Math.max(a, Number(s.resume_time) || 0), 0);
  check('W3 the position is saved at all (the control the next two need)',
    furthest > 30, `furthest resume_time=${furthest.toFixed(1)}s over ${rows.length} save(s)`);
  check('W4 watched time is reported (it was hardcoded to 0 on every save)',
    watched >= 1.5, `summed playDuration=${watched.toFixed(1)}s`);
  check('W5 ...and is the time watched, not the position — the 30s skim is not credited',
    watched < 15,
    `summed playDuration=${watched.toFixed(1)}s against a furthest position of ` +
    `${furthest.toFixed(1)}s; position-as-duration would sum to well over 30`);

  // ── W6/W7: a rejected write is visible ───────────────────
  // The chip is the only signal that nothing reaches Stash, so assert both
  // directions: appearance alone would pass on a chip latched forever.
  await setMode({ save: 'fail' });
  await setPlaying(true);
  await seekTo(42);
  await sleep(300);
  await setPlaying(false);
  await sleep(800);
  check('W6 a rejected save is announced rather than swallowed',
    /sync failed/i.test(syncText() || ''), `chip="${syncText()}"`);
  check('W6 ...and carries the server\'s reason',
    /simulated save failure/.test(syncTitle()), `title="${syncTitle()}"`);

  await setMode({ save: 'ok' });
  await setPlaying(true);
  await sleep(500);
  await setPlaying(false);
  await sleep(600);
  check('W7 the chip clears once the server takes a save again',
    /^saved$/i.test(syncText() || ''), `chip="${syncText()}"`);

  // ── W8: a finished scene leaves Continue Watching ────────
  // Stash overwrites `resume_time`, and the shelf filters `resume_time > 0`, so
  // the last write decides. `ended` is dispatched: the file is 60 s, and
  // waiting would also stop the transport used above.
  const END_SCENE = {
    ...SCENE,
    id: '9093',
    title: 'VERIFY — completion harness',
    stream: `http://127.0.0.1:${PORT}/tone5.wav`,
    resume_time: 0,
  };
  const EQ = { items: [END_SCENE], total: 1, page: 1, startIndex: 0, startSeconds: 0 };

  await setMode({ resume: 0, save: 'ok', sceneAddPlay: 'ok' });
  await clearLogs();
  window.__activity = [];
  window.__mountQueue(EQ, 7);
  await sleep(1200);
  const endV = video();
  check('W8 setup: the completion scene is playing',
    !!endV && endV.paused === false && playingTitle() === 'VERIFY — completion harness',
    `paused=${endV?.paused}`);
  await seekTo(45);
  await sleep(700);            // let the seek's own save settle first
  endV.dispatchEvent(new Event('ended'));
  await sleep(900);

  const endRows = (await saves()).filter(s => s.id === '9093');
  const lastEnd = endRows[endRows.length - 1];
  check('W8 a finished scene is saved at position zero',
    !!lastEnd && Number(lastEnd.resume_time) === 0,
    `${endRows.length} save(s), last resume_time=${lastEnd?.resume_time} ` +
    `(the playhead was at ${endV.currentTime.toFixed(1)}s)`);
  check('W8 ...so the shelf can drop the card without waiting for a remount',
    (window.__activity || []).some(a => a.id === '9093' && a.resumeTime === 0),
    JSON.stringify(window.__activity));

  // ── W9: a failed per-open state read is announced ───────
  // The read supplies resume point, play count and markers, so failure means
  // unknown, not absent; swallowed it looks like an unwatched scene. It uses
  // the same sync chip as a failed write.
  const STATE_SCENE = {
    ...SCENE,
    id: '9094',
    title: 'VERIFY — state-read harness',
    stream: `http://127.0.0.1:${PORT}/tone7.wav`,
    resume_time: 0,
  };
  await setMode({ findSceneState: 'fail', resume: 0, save: 'ok', sceneAddPlay: 'ok' });
  window.__mountQueue(
    { items: [STATE_SCENE], total: 1, page: 1, startIndex: 0, startSeconds: 0 }, 9);
  const announced = await waitFor(() => /sync failed/i.test(syncText() || ''), 3000);
  check('W9 a failed per-open state read is announced in the sync chip', announced,
    `chip="${syncText()}"`);
  check('W9 ...carrying the server\'s reason',
    /simulated state read failure/.test(syncTitle()), `title="${syncTitle()}"`);
  await setMode({ findSceneState: 'ok' });

  // ── Q8: a scene ending while the next page is arriving ───
  // Prefetch starts three rows before the end, so a short scene can end while
  // the extension is in flight. `goNext` asked `extend()`, got "already
  // running" → false, and stopped on the page's last frame. The deferred
  // `fetchPage` makes that window reachable on demand.
  const PAGE_A = { ...SCENE, id: '9300', title: 'VERIFY page one' };
  const PAGE_B = { ...SCENE, id: '9301', title: 'VERIFY page two' };
  let pageFetches = 0;
  const PQ2 = {
    items: [PAGE_A],
    total: 2,
    page: 1,
    startIndex: 0,
    startSeconds: 0,
    fetchPage: async () => {
      pageFetches += 1;
      await sleep(800);
      return { items: [PAGE_B], total: 2 };
    },
  };

  await setMode({ resume: 0, save: 'ok', sceneAddPlay: 'ok' });
  window.__mountQueue(PQ2, 8);
  await sleep(250);            // the mount-time prefetch is now in flight
  check('Q8 setup: the page boundary is reached while the next page is in flight',
    playingTitle() === 'VERIFY page one' && pageFetches === 1,
    `title="${playingTitle()}" fetches=${pageFetches}`);
  video()?.dispatchEvent(new Event('ended'));
  const advanced = await waitFor(() => playingTitle() === 'VERIFY page two', 3000);
  check('Q8 a scene ending mid-prefetch advances rather than stopping', advanced,
    `title="${playingTitle()}" after the join`);
  check('Q8 ...without asking the server for the page twice',
    pageFetches === 1, `${pageFetches} page fetch(es)`);

  // ── RS: resume, or start over ────────────────────────────
  // The thresholds are 10 s from the start and 30 s from the end of this 60 s
  // file, so only 11–29 is asked about. Use 22, and tell the endpoint 22 so the
  // per-open refresh cannot be what makes the difference.
  const RESUME_SCENE = {
    ...SCENE,
    id: '9091',
    title: 'VERIFY — resume harness',
    stream: `http://127.0.0.1:${PORT}/tone4.wav`,
    resume_time: 22,
  };
  const RQ = { items: [RESUME_SCENE], total: 1, page: 1, startIndex: 0, startSeconds: 0 };

  await setMode({ resume: 22, save: 'ok', sceneAddPlay: 'ok', sceneUpdate: 'ok' });
  window.__mountQueue(RQ, 4);
  await sleep(1200);
  check('RS1 a saved position raises the question before anything plays',
    !!resumePrompt() && video()?.paused === true,
    `prompt=${!!resumePrompt()} paused=${video()?.paused}`);
  check('RS1 ...and the scene has not already been jumped to it',
    (video()?.currentTime || 0) < 1, `currentTime=${video()?.currentTime?.toFixed(2)}`);
  check('RS2 the cursor starts on Resume, so the default is one OK away',
    /resume from/i.test(document.activeElement?.textContent || ''),
    `activeElement="${document.activeElement?.textContent?.trim()}"`);
  check('RS2 ...and the label names the position, so the default is visible',
    /0:22/.test(resumePrompt()?.textContent || ''),
    `prompt="${resumePrompt()?.textContent?.replace(/\s+/g, ' ').trim()}"`);

  // Same key and cursor position as R4, where it skimmed: a pass here is the
  // player yielding, not a missing binding.
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(250);
  check('RS3 an arrow over the prompt moves the cursor instead of skimming',
    /start from the beginning/i.test(document.activeElement?.textContent || '') &&
      (video()?.currentTime || 0) < 1,
    `activeElement="${document.activeElement?.textContent?.trim()}" ` +
    `currentTime=${video()?.currentTime?.toFixed(2)}`);

  // Back takes the default rather than dismissing: the scene must resume or
  // start, and no third meaning exists. Assert the question is up *before* the
  // Back, or "Back answered it" also passes when the prompt was never raised.
  const upBeforeBack = !!resumePrompt();
  press(document.activeElement, 'Backspace', 10009);
  await sleep(400);
  check('RS4 Back answers the question rather than dismissing it',
    upBeforeBack && !resumePrompt(),
    `up before=${upBeforeBack} after=${!!resumePrompt()}`);
  // Wait, don't sleep: a seek completes on its own schedule, and one still in
  // flight reports a position between the two, a plausible-looking failure of
  // the assertion rather than of the app. The window is generous because the
  // sweep runs three drivers at once and a local fetch plus a seek can take
  // seconds on a loaded machine; 2.5 s flaked once.
  const resumed = await waitFor(() => (video()?.currentTime || 0) > 20, 5000);
  check('RS4 ...by resuming from the saved position and playing',
    resumed && video()?.paused === false,
    `paused=${video()?.paused} currentTime=${video()?.currentTime?.toFixed(2)}`);

  // RS4's control: same scene, saved position and mount; only the answer
  // differs. Also covers the late live value, which must not drag a restarted
  // scene back to 22.
  window.__mountQueue(RQ, 5);
  await sleep(1200);
  check('RS5 setup: the question is up again on the same scene',
    !!resumePrompt() && video()?.paused === true,
    `prompt=${!!resumePrompt()} paused=${video()?.paused}`);
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(250);
  ok(document.activeElement);   // "Start from the beginning"
  await sleep(1400);
  check('RS5 "start from the beginning" plays from 0, and stays there',
    !resumePrompt() && video()?.paused === false && (video()?.currentTime || 0) < 5,
    `paused=${video()?.paused} currentTime=${video()?.currentTime?.toFixed(2)} ` +
    '(the live refresh must not re-apply the position it just declined)');

  // RS6 is the other half and RS5's control. The question uses the grid's value
  // (opening never waits on a request), while the per-open fetch supplies the
  // applied position: an "unwatched" card against a server at 22 plays to 22
  // with no prompt. Without this, RS5's "stays at 0" would also pass if the
  // live value never arrived.
  const STALE_SCENE = {
    ...SCENE,
    id: '9092',
    title: 'VERIFY — stale card harness',
    stream: `http://127.0.0.1:${PORT}/tone6.wav`,
    resume_time: 0,
  };
  window.__mountQueue(
    { items: [STALE_SCENE], total: 1, page: 1, startIndex: 0, startSeconds: 0 }, 6);
  await sleep(900);
  check('RS6 a card with no saved position is not asked about, even when the server has one',
    !resumePrompt(), `prompt=${!!resumePrompt()}`);
  const applied = await waitFor(() => (video()?.currentTime || 0) > 18, 5000);
  check('RS6 ...and the freshly-fetched position is applied without asking',
    applied && video()?.paused === false,
    `paused=${video()?.paused} currentTime=${video()?.currentTime?.toFixed(2)} — the ` +
    'per-open findScene reports 22, so the value RS5 declined demonstrably arrives');

  await finish();
}

// The StrictMode probe owns the document first and unmounts before the harness
// exists, so the selectors below match exactly one player.
(async () => {
  try {
    await runStrictProbe();
  } catch (e) {
    check('K0 the StrictMode probe ran', false, String((e && e.stack) || e));
  }
  createRoot(document.getElementById('root')).render(<Harness />);
  try {
    await run();
  } catch (e) {
    results.push({
      name: 'HARNESS CRASHED',
      pass: false,
      detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
    });
    try { await finish(); } catch { /* nothing left to do */ }
  }
})();
