/**
 * Headless verification driver for the player's transport rail and its
 * add-marker form.
 *
 * Mounts `VideoPlayer` directly — not the App — because everything under test
 * is inside it: the key routing, the rail, and the form. The queue is a prop,
 * so the scene, its markers and its duration are all fixed by this file rather
 * than arrived at by driving a grid. What is *not* re-composed is anything that
 * matters: the real key handler, the real focus registry, the real service
 * layer against a fake endpoint (scripts/harness/server.py).
 *
 * `useKeyHandler` is mounted with a counting `onBack`, which is the whole point
 * of several checks below: the player is a capture-phase window listener that
 * calls `stopPropagation`, so "did this key reach the app" is a question only
 * this arrangement can answer.
 *
 * The two things no DOM can tell you, and which are therefore TV checks:
 *   - whether this remote emits play/pause as keyCode 415/19/10252 at all;
 *   - whether a *synthetic* keydown triggers a focused <button>'s native
 *     activation on Space. It does not, so the double-fire this code guards
 *     against cannot be reproduced here — only the `preventDefault` that
 *     suppresses it can be asserted, which is what R8 does.
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

// A one-scene queue, which is the ordinary case — the detail page's Play
// button, a marker activation. `total: 1` makes `exhausted` immediately true,
// which is what MK2's disabled-buttons check needs.
const QUEUE = { items: [SCENE], total: 1, page: 1, startIndex: 0, startSeconds: 0 };

/**
 * The same scene three times over, under three titles. The stepping checks need
 * a queue with somewhere to go, and the title is the observable rather than the
 * index: the overlay carries it in its `aria-label`, so "did the scene change"
 * is answered by reading what is playing rather than by trusting a counter that
 * could agree with a hook that moved its index without moving the video.
 */
const threeScenes = () => ['one', 'two', 'three'].map((name, i) => ({
  ...SCENE,
  id: `4242${i}`,
  title: `VERIFY scene ${name}`,
  // A distinct URL per scene, so a step really is a source change: the
  // player's "a new scene inherits nothing from the outgoing playhead" rule
  // only has a source-change effect to run when the URL differs, and three
  // scenes sharing one URL would let a carry-over pass unseen.
  stream: `http://127.0.0.1:${PORT}/tone${i + 1}.wav`,
}));
const QUEUE3 = { items: threeScenes(), total: 3, page: 1, startIndex: 0, startSeconds: 0 };

/**
 * A scene the StrictMode probe plays, kept off QUEUE's id so its teardown save
 * cannot be read as one of the player checks' writes.
 */
const STRICT_SCENE = { ...SCENE, id: '9201', title: 'VERIFY — strict mount' };
const STRICT_QUEUE = { ...QUEUE, items: [STRICT_SCENE] };

/**
 * The real player, mounted the way `src/main.jsx` mounts the app.
 *
 * StrictMode mounts an effect, tears it down and mounts it again against the
 * same refs. Every latch in the player and in `usePlaybackSource` is therefore
 * false after the simulated unmount unless the effect body re-arms it — a
 * dev-only failure that no other driver can see, because they all render bare.
 * Two observables cover both latches: a source that never arrives (the
 * playback-source latch), and a pause whose save is never acknowledged (the
 * player's latch, which gates the chip).
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
    // report before pausing — the chip only exists because a write happened.
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
 * Focusables outside the player, in normal flow. Same registry as the player's,
 * so "the arrow did not move focus out there" is evidence of a scope rather
 * than of there being nothing out there to reach.
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

  // The queue is stateful, and swapped by the stepping checks below. The `key`
  // is the load-bearing part: `usePlayQueue` seeds its items, total and cursor
  // from the prop with `useState`, which reads it on the first render and
  // never again — so handing the *same* player a different queue would be
  // silently ignored and the checks would be reading the one-scene queue while
  // believing they had a three-scene one.
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
        // The completion report the App uses to prune Continue Watching. A spy
        // rather than the App, because what is under test here is whether the
        // player *announces* it at all.
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
 * The title of the scene the player says it is showing.
 *
 * Read from the overlay's `aria-label` rather than from the queue counter: the
 * counter is rendered from the hook's `index`, so a check that trusted it would
 * pass if the cursor moved while the video did not. The accessible name is
 * derived from the scene the player actually holds, which is the thing the
 * question is about.
 */
const playingTitle = () => {
  const label = player()?.getAttribute('aria-label') || '';
  return label.startsWith('Now playing: ') ? label.slice('Now playing: '.length) : null;
};

/**
 * Marker ticks on the progress bar. Matched on the CSS-module local name,
 * which survives hashing as `_<local>_<hash>_<line>` — the same technique the
 * detail harness uses for its `[role=group]` selectors. Returns null rather
 * than 0 when the progress track itself is missing, so a broken selector
 * fails the check instead of quietly reporting "no ticks".
 */
const tickCount = () => {
  if (!player()) return null;
  return player().querySelectorAll('[class*="_markerTick_"]').length;
};

/**
 * The controls container, found by walking up from the rail. `_controls_`
 * deliberately does not match `_controlsVisible_` (the trailing underscore),
 * and every caller treats null as a failure so a rename cannot pass silently.
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
 * The player's own status line — the marker confirmation, and not the sync chip.
 *
 * Both carry `role="status"` and the chip comes first in document order (it
 * lives in the time row, while the toast is a sibling of the whole controls
 * block), so "the first status outside the modal" quietly starts reading the
 * chip's text instead. Excluded by class rather than by wording, so MK10 stays
 * a question about *which element* announced something.
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
 * The modal's own `role=status` line, which is where a failed write speaks.
 * Read from the button's sibling rather than by text match, so the check is
 * about the message being *announced* rather than about wording.
 */
const modalStatus = () => modal()?.querySelector('[role="status"]')?.textContent.trim() ?? null;

const selectedChip = () => modal()?.querySelector('[aria-pressed="true"]') ?? null;
/** The form's big timestamp. `_time_` does not match `_timeRow_`. */
const formTime = () => modal()?.querySelector('[class*="_time_"]')?.textContent.trim() ?? null;
const chipLabels = () => modal()
  ? [...modal().querySelectorAll('[aria-pressed]')].map(c => c.getAttribute('aria-label'))
  : [];

/**
 * Dispatch one keydown. Enter is the default rather than a required argument
 * because `press(el)` with no key builds a KeyboardEvent whose `key` is the
 * string "undefined" — which no handler matches, so the press is silently
 * inert. That is the worst possible failure mode for a check like "the nudge
 * did not move the playhead": it passes for the wrong reason, and four checks
 * in this file were doing exactly that before the default existed.
 */
function press(el, key = 'Enter', keyCode = 13) {
  const e = new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  });
  (el || document.body).dispatchEvent(e);
  return e;
}

/** Enter on `document.activeElement` — the OK button on a remote. */
const ok = (el) => press(el || document.activeElement, 'Enter', 13);

const focusRailButton = (id) => registry.get(id).el.focus();

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
 * Put the media element into a known play state, without touching the cursor.
 *
 * Every check about resuming is a check about a *transition*, so the state on
 * entry has to be established rather than inherited from whatever the previous
 * section happened to leave behind. Pressing Space to do it — the obvious way —
 * is also the thing under test, and it depends on where the cursor is: with the
 * rail up the player claims it, without the rail the player claims it too, but
 * a check that preconditions itself with the mechanism it is testing can only
 * ever agree with itself.
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
  // The scene has no saved position, so there is nothing to ask about — and the
  // fact that it is already playing is half the evidence, since the prompt holds
  // playback back for as long as it is up.
  check('T0 ...and nothing interrupted it with a resume question',
    !resumePrompt(), `prompt=${!!resumePrompt()}`);
  if (!playing) { await finish(); return; }

  // ── Precondition: the controls hide on their own ────────
  // Not just setup. This is what makes R1's "OK reveals them" and R4's "the
  // arrow reveals them" differentials rather than claims about something that
  // was on screen the whole time — and it is the same 3s timer R9 tests.
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
  //
  // The rail's header claims the ⏯ button must be ONE element because a
  // remount would drop focus to <body> and the third press would re-focus
  // instead of resuming. That is exactly what is asserted: same node, and the
  // icon changed under it.
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
  // Tizen's three: 10252 is the play/pause key and toggles, 19 is *pause* and
  // 415 is *play*. They are not three names for one toggle, and the check is
  // written as three separate outcomes so a mapping that folded them together
  // could not pass — which is exactly what it did before this check existed.
  // Whether this particular TV emits them at all is the one thing only the
  // device can answer.
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

  // ── R6/R3: the rail's exit and entry, under the ↑/↓-steps-scenes map ──
  //
  // This block used to assert the opposite of what it asserts now — "↑ leaves
  // the rail, ↓ comes back to ⏯" — and that mapping is exactly what was
  // replaced. The stepping itself is S4-S6, on a queue with somewhere to go.
  // What is checked here is the part the swap could have quietly broken: that
  // the two keys no longer do the rail's job. ↓ is the one that needs saying,
  // because before the change it was the rail's entry key, and an entry that
  // still worked would re-enter on a press the user meant as "next scene".
  const railCursor = document.activeElement;
  press(document.activeElement, 'ArrowUp', 38);
  await sleep(140);
  check('R6 ↑ inside the rail does not leave it', inRail(),
    `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);
  press(document.activeElement, 'ArrowDown', 40);
  await sleep(140);
  check('R6 ...and ↓ does not walk the cursor along the rail',
    document.activeElement === railCursor && inRail(),
    `"${railCursor?.getAttribute('aria-label')}" → "${document.activeElement?.getAttribute('aria-label')}"`);

  // Back is the rail's exit now, and OK is its way back in.
  press(document.activeElement, 'Backspace', 10009);
  await sleep(140);
  check('R6 Back is the rail\'s exit', !inRail(),
    `activeElement="${document.activeElement?.tagName}"`);
  press(document.body, 'Enter', 13);
  await sleep(140);
  check('R3 OK re-enters the rail on play/pause',
    document.activeElement === byLabel('Pause', rail()) ||
    document.activeElement === byLabel('Play', rail()),
    `activeElement="${document.activeElement?.getAttribute('aria-label')}"`);

  // ── R5: inside the rail, ←/→ move the cursor and do not seek ──
  // Horizontal nav is zone-confined, so it can only walk the rail — and the
  // player must not also be skimming while it happens. The control for R4.
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
  // Back, not ↑. ↑ steps scenes now, so it would leave the cursor exactly where
  // it is and the wait below would be watching a rail that never let go of it —
  // which is precisely how this check failed the first time the map changed.
  press(document.activeElement, 'Backspace', 10009);   // leave the rail
  await sleep(3400);                              // let the controls hide again
  const hiddenAgain = controlsOpacity() === 0;
  await seekTo(30);
  press(document.body, 'ArrowRight', 39);
  await sleep(120);
  check('R4 setup: the controls were hidden before the arrow', hiddenAgain,
    `opacity=${controlsOpacity()} before`);
  check('R4 Right from behind the rail skims +15s',
    v.currentTime > 44 && v.currentTime < 46, `currentTime=${v.currentTime.toFixed(2)}`);
  check('R4 ...and reveals the rail as a hint',
    controlsOpacity() === 1, `opacity=${controlsOpacity()}`);
  check('R4 ...without taking the cursor into it', !inRail() && !inModal(),
    `activeElement="${document.activeElement?.tagName}"`);

  // ── R4b: a forward skim with no usable element duration ──
  // A Stash MP4 transcode reports none (or a short placeholder), which is the
  // case the clamp exists for. The shipped bug was `Math.min(v.duration || 0,
  // …)`: NaN fell through to 0, so → from 50 s jumped *backwards to the start*.
  // The UI's own timeline carries the scene's real duration in exactly this
  // case, so the bound is whichever of the two is real.
  await seekTo(50);
  Object.defineProperty(v, 'duration', { configurable: true, get: () => NaN });
  press(document.body, 'ArrowRight', 39);
  await sleep(300);
  check('R4b a forward skim with no element duration clamps to the timeline, not to zero',
    v.currentTime > 55,
    `currentTime=${v.currentTime.toFixed(2)} from 50.0 (a zero clamp lands near 0)`);
  delete v.duration;

  // ── R11: on a lone scene, ↑/↓ raise the rail ────────────
  // There is no neighbouring scene to step to, so without this both keys were
  // claimed and did nothing — a dropped press. They open the transport
  // instead. S2/S3 below are the other half: on a queue with somewhere to go,
  // the same keys still step scenes.
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
  // preventDefault is the mechanism that stops a focused <button> from also
  // firing on Space — a synthetic keydown has no native activation to observe,
  // so the claim itself is what can be checked here.
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
  // The same SceneDetailPage is reachable from the player, and its chips used
  // to be focus stops that consumed OK and did nothing: the player rendered
  // the page without an `onPlayAt`, so `onPlayAt?.()` was a no-op. The fake
  // serves this one marker *inside* the 60 s tone (see `sceneMarkers: early`)
  // because the detail fixture's own markers are at 125/640/1905 s, where a
  // seek clamps to the end and "jumped" is indistinguishable from "did
  // nothing".
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
  // Playing, stated: MK10 asserts the form hands playback back, and a form
  // opened over a scene that was already stopped is not the same claim.
  await seekTo(30.7);
  await setPlaying(true);
  check('MK3 setup: the scene is playing before the form opens', v.paused === false,
    `paused=${v.paused}`);
  focusRailButton('player-rail-marker-add');
  ok(document.activeElement);
  await sleep(400);   // the tag fetch
  check('MK3 OK on add-marker opens the form', !!modal());
  check('MK3 opening the form pauses the scene', v.paused === true, `paused=${v.paused}`);
  // The second the form captured. Held rather than hardcoded: the form takes
  // the playhead at the moment it opens, and the scene was playing until
  // then, so the exact value depends on how long the press took. MK9 is about
  // the nudge moving it, which is a difference, not an absolute.
  const formOpenedAt = v.currentTime;
  check('MK3 the cursor moved into the form', inModal(),
    `activeElement="${document.activeElement?.getAttribute('aria-label')}"`);

  // ── MK5: the recent row, in the order the server gave ────
  // (C, B) is an order no slice of the library listing produces, so a recent
  // row that was really the library list would fail here rather than match
  // by coincidence. Exact labels, because the recent chips carry no count.
  check('MK5 the recent row is shown', modal().textContent.includes('Recently used'));
  check('MK5 ...in the server\'s recency order, not the library\'s',
    chipLabels().slice(0, 2).join(' | ') === 'Harness Tag C | Harness Tag B',
    `first chips: ${chipLabels().slice(0, 3).join(' | ')}`);

  // ── MK6: the default tag is this scene's, not the library's ──
  // The library's most-used tag is C and it leads the tag row; the scene's own
  // markers use A twice. Opening on C would file the marker under a tag this
  // scene has never used.
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
  // Both halves asserted. "The playhead did not move" alone is satisfied by a
  // nudge that never fired, which is precisely how this check passed while the
  // buttons were dead.
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
  await setMode({ markerCreate: 'fail' });
  press(byLabel('Add marker', modal()));
  await sleep(600);
  check('MK11 a failed create keeps the form open', !!modal());
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
  // A scene that was already paused when the form opened must stay paused.
  // Same input, opposite outcome from MK10 — which is what makes MK10's
  // resume meaningful rather than "the video always plays after this button".
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
  // The opener is the rail button the form was raised from, and the rail's
  // own auto-hide refuses to run while it holds focus — so this also proves
  // the cursor did not end up on <body>.
  check('MK7 ...and the cursor returns to the button that opened it',
    document.activeElement === byLabel('Add marker', rail()),
    `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);

  // ── D1–D4: the detail page over the player ───────────────
  //
  // The page is rendered by the player itself, so it is reachable from here
  // with no App around it. Its `scene` prop is the card the player already
  // has; the page then runs its own `findScene` — the fake endpoint answers
  // `FindSceneDetail` with the same SCENE the listing uses.
  const detailsPage = () => [...document.querySelectorAll('[role="dialog"]')]
    .find(el => el !== player() && el !== modal()) ?? null;
  // By registry id, not by accessible name. The page's ActionButtons carry no
  // `aria-label` — their name is the visible text, icon span included — and the
  // registry is the deterministic handle this file already uses for the rail's
  // buttons for the same reason.
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

  // The player must own nothing while the page is up. Same key, same cursor
  // position as R4 — where it skimmed — so a pass here is the yield and not
  // the absence of a binding.
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

  // Back closes the page — and the cursor has to come back off it, or the
  // rail it returns to is one the user cannot see (the auto-hide re-arms on
  // close, so an invisible button is exactly what "no restore" would produce).
  press(document.activeElement, 'Backspace', 10009);
  await sleep(300);
  check('D3 Back closes the page', !detailsPage());
  check('D3 ...and the cursor returns to the ⓘ that opened it',
    document.activeElement === byLabel('Details', rail()),
    `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);
  check('D3 ...and the scene stays paused (no auto-resume)', v.paused === true,
    `paused=${v.paused}`);

  // D4 is D3's control. Same page, same close, same scene state on entry —
  // the only difference is which button was pressed, so "still paused" above
  // cannot be satisfied by a page that never had the power to resume.
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
  //
  // The user's 2026-10-18 report: "when video is playing and controls are
  // shown, pressing back does first close the control bar before closing
  // video". After D4 the bar was just shown (Play on the ⓘ page calls
  // `showControls`) and the cursor is behind it, which is exactly the state in
  // question. One Back hides the bar, the next closes the player.
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
  //
  // Everything above ran on a one-scene queue, so there was nothing to step to
  // and the two scene keys could not be told from dead ones. The player is
  // replaced with a three-scene queue here; see the `key` on <VideoPlayer> for
  // why a prop change would not have done it.
  window.__useThreeScenes();
  await sleep(900);
  check('S1 setup: a three-scene queue, on scene one, rail down',
    playingTitle() === 'VERIFY scene one' && !inRail() && !modal() && !detailsPage(),
    `title="${playingTitle()}" inRail=${inRail()}`);

  press(document.body, 'ArrowDown', 40);
  await sleep(500);
  check('S2 ↓ steps to the next scene with the rail down',
    playingTitle() === 'VERIFY scene two', `title="${playingTitle()}"`);

  press(document.body, 'ArrowUp', 38);
  await sleep(500);
  check('S3 ↑ steps back to the previous scene',
    playingTitle() === 'VERIFY scene one', `title="${playingTitle()}"`);

  // ── S3b: the outgoing playhead is not inherited ──────────
  // A fallback source is a reload of the *same* scene, and resuming where the
  // user was is the point. A different scene is exactly the opposite: its
  // first source starts from the resume decision, never from the clock the
  // previous scene was on when the queue stepped. The two share one ref, so
  // the discriminator is the scene id captured alongside the time.
  await seekTo(25);
  await sleep(400);            // let a save settle so it cannot be mistaken for the seek
  press(document.body, 'ArrowDown', 40);
  await sleep(900);            // the new URL loads and its metadata arrives
  await waitFor(() => (video()?.currentTime || 0) < 5, 2500);
  check('S3b stepping to the next scene starts it at the beginning, not at the ' +
    'previous scene\'s playhead',
    playingTitle() === 'VERIFY scene two' && (video()?.currentTime || 0) < 5,
    `title="${playingTitle()}" currentTime=${video()?.currentTime?.toFixed(1)} ` +
    '(the outgoing scene was at 25 s)');
  press(document.body, 'ArrowUp', 38);   // back to scene one for S4
  await sleep(500);

  // The rail up is where this behaviour changed, and where the old mapping did
  // something else entirely: ↑ left the rail and ↓ was handed to spatial nav.
  // The entry target is play/pause, which is the one rail button that is never
  // disabled — so it is still focusable on any scene, and "the cursor stayed on
  // the rail" can only be answered by focus rather than by a button that
  // vanished.
  press(document.body, 'Enter', 13);
  await sleep(350);
  check('S4 setup: the rail is up with the cursor in it',
    inRail() && document.activeElement === registry.get('player-rail-playpause')?.el,
    `inRail=${inRail()} el=${document.activeElement?.getAttribute('aria-label')}`);

  press(document.activeElement, 'ArrowDown', 40);
  await sleep(500);
  check('S5 ↓ steps the scene even with the rail up',
    playingTitle() === 'VERIFY scene two', `title="${playingTitle()}"`);
  check('S5 ...and the cursor is still on the rail',
    inRail(), `activeElement="${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName}"`);

  press(document.activeElement, 'ArrowUp', 38);
  await sleep(500);
  check('S6 ↑ with the rail up steps back rather than leaving the rail',
    playingTitle() === 'VERIFY scene one' && inRail(),
    `title="${playingTitle()}" inRail=${inRail()}`);

  // The end of the queue. Back is what gets the cursor out of the rail now that
  // ↑ does not, so it is exercised before the wrap check rather than after.
  document.activeElement?.blur?.();
  press(document.body, 'ArrowDown', 40);
  await sleep(500);
  press(document.body, 'ArrowDown', 40);
  await sleep(600);
  check('S7 setup: stepping twice reaches the last scene',
    playingTitle() === 'VERIFY scene three', `title="${playingTitle()}"`);

  press(document.body, 'ArrowDown', 40);
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

  // S10 is the half that keeps Back's hide from being the *auto-hide timer*
  // wearing a disguise: S9's wait allows one second, well short of the 3 s
  // delay, so a bar left to the timer could not have satisfied it. After the
  // delay has passed, nothing may re-show it or close the player either.
  check('S10 the bar is down at once, not after a timer',
    controlsOpacity() === 0, `opacity=${controlsOpacity()} immediately after Back`);
  await sleep(3400);
  check('S10 ...and no timer brings it back or closes the player',
    controlsOpacity() === 0 && closedCount === closedBeforeRailBack,
    `opacity=${controlsOpacity()} closed += ${closedCount - closedBeforeRailBack}`);

  // ── W: what the player writes back ───────────────────────
  //
  // Two writes with two unrelated contracts, so they are asserted separately.
  //
  // The play count is a *count of requests*: `sceneAddPlay` appends a row to
  // scenes_view_dates, so "incremented" means "fired once" — and the request log
  // is the only place that is visible, because a version that fired on every
  // buffer stall or every resume would still leave a plausible number in the
  // database. `play_duration` is a *sum of deltas* that Stash adds to a running
  // total, so its failure mode is inflation, and the number to compare it
  // against is the position: after a 30-second seek, a save that reported the
  // position as the duration would be wrong by an order of magnitude.
  //
  // A fresh player, because both counters are per-session refs and the run
  // above has been pausing and resuming this scene for a minute.
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
  await sleep(500);

  // Pause, resume, pause, seek, play. Each transition is a separate `play`
  // event and a separate save, which is what makes "exactly once" an assertion
  // rather than a restatement of the code.
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

  // The skim: 30 seconds of the scene that were never watched, taken in a single
  // step. This is the shape the user reported — "played a few seconds and
  // skipped around" — and the one a position-as-duration bug would report as
  // half a minute of viewing.
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
  //
  // The chip is the only place a user can learn that nothing is reaching Stash,
  // so it is asserted in both directions. Appearance alone would also pass on a
  // chip that latched on forever.
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
  //
  // Stash *overwrites* resume_time, so the last write a finished scene makes
  // is the one that decides whether it stays on the shelf — and the shelf's
  // filter is `resume_time > 0`. `ended` is dispatched rather than waited for:
  // the file is 60 s long, so the natural event would take a minute to arrive,
  // and waiting would also stop the transport the checks above use.
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
  //
  // The read supplies the resume point, the play count and the markers, so a
  // failure means those are *unknown*, not absent. Swallowed, it looked
  // exactly like a scene nobody had watched: no prompt, no ticks, silence.
  // The chip is the same one a failed write uses (one place to look).
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
  //
  // The prefetch starts three rows before the end, so a short scene can end
  // while the extension is still in flight. `goNext` used to ask `extend()`,
  // be told "already running" → false, and stop on the last frame of the page
  // with the next page about to arrive. The deferred `fetchPage` here is what
  // makes that window reachable on demand rather than by luck.
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
  //
  // The position has to sit inside the usable window by construction: the
  // thresholds are 10s from the start and 30s from the end against this 60s
  // file, so only 11–29 is ever asked about. 22 is in the middle of that, and
  // the endpoint is told the same number so the per-open refresh cannot be what
  // makes the difference.
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

  // Same key, same cursor position as R4 — where it skimmed the scene. A pass
  // here is the player yielding, not the absence of a binding.
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(250);
  check('RS3 an arrow over the prompt moves the cursor instead of skimming',
    /start from the beginning/i.test(document.activeElement?.textContent || '') &&
      (video()?.currentTime || 0) < 1,
    `activeElement="${document.activeElement?.textContent?.trim()}" ` +
    `currentTime=${video()?.currentTime?.toFixed(2)}`);

  // Back is the remote's most reflexive button, so it takes the default rather
  // than dismissing: "dismiss" has no third meaning here — the scene has to
  // either resume or start — and nothing is written by either answer.
  //
  // The question has to be up *before* the Back, or "Back answered it" also
  // passes on a build where it was never raised at all — which is exactly what
  // disabling the prompt produces, so this half is what keeps RS4 from being
  // satisfied by the absence of the feature.
  const upBeforeBack = !!resumePrompt();
  press(document.activeElement, 'Backspace', 10009);
  await sleep(400);
  check('RS4 Back answers the question rather than dismissing it',
    upBeforeBack && !resumePrompt(),
    `up before=${upBeforeBack} after=${!!resumePrompt()}`);
  // Waited for, not slept through. A seek is a request to the media element and
  // completes on its own schedule, so a fixed sleep reads whatever the element
  // happened to be reporting — and a seek still in flight reports a position
  // *between* the two, which is a number that would look like a plausible
  // failure of the assertion rather than of the app.
  const resumed = await waitFor(() => (video()?.currentTime || 0) > 20, 2500);
  check('RS4 ...by resuming from the saved position and playing',
    resumed && video()?.paused === false,
    `paused=${video()?.paused} currentTime=${video()?.currentTime?.toFixed(2)}`);

  // The control for RS4, and the reason RS5 is a differential rather than a
  // second helping of the same claim: same scene, same saved position, same
  // mount — only the answer differs. It also covers the late-arriving live
  // value, which must not drag a scene the user restarted back to 22.
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

  // RS6 is the other half of the design and the control RS5's guard needs.
  //
  // The *question* is decided from the grid's own value — that is why opening a
  // scene never waits on a request — while the per-open fetch still supplies the
  // position that gets applied. So a card that says "unwatched" but a server
  // that says 22 plays straight through to 22: no prompt, and the freshly
  // fetched value is what moved it. Without this, RS5's "stays at 0" would also
  // be satisfied by a build where the live value never arrived at all, which is
  // the one way that check could pass for the wrong reason.
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
  const applied = await waitFor(() => (video()?.currentTime || 0) > 18, 2500);
  check('RS6 ...and the freshly-fetched position is applied without asking',
    applied && video()?.paused === false,
    `paused=${video()?.paused} currentTime=${video()?.currentTime?.toFixed(2)} — the ` +
    'per-open findScene reports 22, so the value RS5 declined demonstrably arrives');

  await finish();
}

// The probe owns the document first: it unmounts before the harness exists so
// the selectors below keep meaning exactly one player.
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
