/**
 * Headless driver for Back while the player is open over the performer page.
 *
 * The report (2026-10-20): "backing out from playing a scene, selected from
 * the performer page, returns back to full performer listing (not the
 * performer we were at)". Which is to say the *page* and the *player* both
 * acted on the same Back press.
 *
 * Two independent listeners claim Back here. PerformerDetailPage installs one
 * on mount with `isBackKey(e) && !focusScopeOf(document.activeElement)` as its
 * guard; the player installs one when it mounts. Both are window capture
 * listeners, so they run in registration order — the page first, because it
 * was there first — and `stopPropagation` cannot suppress a sibling listener
 * on the same target. The page's guard asks whether *focus* is inside a
 * dialog, and while the player is open focus is on <body> (the detail page
 * unmounted with the Play press and the player deliberately never focuses its
 * own container — see useControlsVisibility's leaveRail), so the guard sees
 * nothing and the page closes itself underneath the player.
 *
 * The assertions are ordered so the difference is visible rather than just
 * red: the first Back is the player's controls-bar press, and it must not
 * touch the page. The second closes the player and must land back on the
 * performer, with focus on the card that was played.
 *
 * Mounts the real App against the fake GraphQL endpoint, like menu-entry.
 *
 * What this cannot tell you: whether the TV's remote sends the same keydown
 * this driver does. Nothing here is timing-sensitive in that way (the keys
 * are real events through the real hooks), but the remote itself is the TV
 * pass.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry, getCurrentFocusId } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const active = () => document.activeElement || document.body;

function press(key, keyCode) {
  active().dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}

// Cards move their short action to keyup when they pass `onLongPress`, so a
// real activation needs both halves. Rail rows and buttons do not care, and
// an extra keyup is inert for them.
async function tapEnter() {
  const el = active();
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
  }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(new KeyboardEvent('keyup', {
    key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
  }));
  await sleep(250);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};

async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* still settling */ }
    await sleep(50);
  }
  return false;
}

// The player's own overlay, by the label it announces rather than by class —
// the CSS-module name is hashed, and the check is about which layers are up.
const playerDialog = () => [...document.querySelectorAll('[role="dialog"]')]
  .find(d => (d.getAttribute('aria-label') || '').startsWith('Now playing:')) || null;

// Only the performer page has this button; the Performers grid (the wrong
// destination) has no such label, so it is also the assertion that the page
// underneath survived rather than being replaced by the listing.
const performerPageOpen = () => !!document.querySelector('button[aria-label="Back to performers"]');

async function run() {
  // ── Arrive on the performer page ──────────────────────────
  await waitFor(() => registry.has('nav-performers'));
  await sleep(400);   // Home's autoFocus timer runs after mount
  focus('nav-performers');
  await sleep(120);
  await tapEnter();

  await waitFor(() => registry.has('performer-1'));
  await sleep(300);
  focus('performer-1');
  await sleep(120);
  await tapEnter();

  const detailReady = await waitFor(() => performerPageOpen() && registry.has('video-1'));
  check('P0 the performer page opens with its scene grid',
    detailReady,
    `back button ${performerPageOpen()}, video-1 ${registry.has('video-1')}`);

  // ── Open the scene's detail page, then play from it ───────
  // The ordinary path: Enter on a card opens the page, Play starts it. The
  // page is what App closes when playback starts, so the only page left
  // underneath the player is the performer page.
  focus('video-1');
  await sleep(120);
  await tapEnter();
  const sceneDetailOpen = await waitFor(() => registry.has('scene-play'));
  check('P1 Enter on a scene card opens its detail page', sceneDetailOpen);

  focus('scene-play');
  await sleep(120);
  await tapEnter();
  const playing = await waitFor(() => !!playerDialog());
  check('P2 Play opens the player over the performer page',
    playing && performerPageOpen(),
    `player ${!!playerDialog()}, performer page ${performerPageOpen()}`);

  // ── Back #1: the controls bar ─────────────────────────────
  // The player layers Back: with its bar up, the first press puts the bar
  // away. The performer page must observe that and do nothing — it is not the
  // top layer.
  await sleep(200);
  press('Escape', 27);
  await sleep(350);
  check('P3 Back with the player up does not close the page underneath',
    performerPageOpen(),
    `performer page ${performerPageOpen()}`);

  // ── Back #2: the player ───────────────────────────────────
  // And when the player does close, what is revealed is the performer page,
  // with the cursor back on the card that was played.
  press('Escape', 27);
  await sleep(450);
  const closed = !playerDialog();
  check('P4 the second Back closes the player', closed);
  check('P5 ... and reveals the performer page, not the Performers grid',
    performerPageOpen(),
    `performer page ${performerPageOpen()}`);
  check('P6 focus returns to the card that was played',
    getCurrentFocusId() === 'video-1',
    getCurrentFocusId() ?? '<none>');
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

const root = document.getElementById('root');
root.style.cssText = 'height:100vh;display:flex;flex-direction:column;overflow:hidden;';
document.body.style.margin = '0';

// Before the render, so the first fetch already sees the fake endpoint.
setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(root).render(<App />);

run()
  .then(finish)
  .catch(async (e) => {
    results.push({
      name: 'HARNESS CRASHED',
      pass: false,
      detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
    });
    try { await finish(); } catch { /* nothing left to do */ }
  });
