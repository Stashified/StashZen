/**
 * Headless probe: how many React commits one interaction costs.
 *
 * Perf work on this app is mostly about *not* re-rendering: the card lists are
 * memoised through useStableListing, the settings stores hand out cached
 * snapshots (useSyncExternalStore), and focus moves are supposed to be DOM
 * only. None of that is visible in a functional check — a card that re-renders
 * forty times still draws the same pixels — so the probe counts commits on a
 * Profiler wrapped around App.
 *
 *   C1  Home is idle: nothing commits for 1.5 s once the shelves have landed
 *   C2  one D-pad move in the Scenes grid costs few commits
 *   C3  a tab switch (a full remount of the page) costs one mount's worth
 *
 * The ceilings are loose on purpose: the numbers are the measurement (printed
 * in the detail), the checks only catch a storm, an idle loop or a remount
 * per keypress. A red C1 is the one to trust — it means something is ticking.
 */

import '../../src/index.css';
import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { getCurrentFocusId, registry } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});

async function waitFor(pred, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(step);
  }
  return false;
}

// ── The counter ────────────────────────────────────────────
let commits = 0;
function onRender() { commits += 1; }
const stopwatch = async (fn, settle = 400) => {
  await sleep(settle);          // let the previous interaction finish
  commits = 0;
  await fn();
  await sleep(settle);
  return commits;
};

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};

async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(150);
}

const press = async (key) => {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await sleep(60);
};

async function switchTab(id) {
  focus(id);
  await sleep(120);
  await tapEnter();
}

async function run() {
  await waitFor(() => registry.has('showroom-recent-scenes-video-1'));
  await sleep(800);             // shelves + images settled

  // ── C1  Nothing ticks while Home sits still ────────────
  const idle = await stopwatch(() => sleep(1500), 300);
  check('C1 an idle Home commits nothing', idle === 0, `${idle} commit(s) in 1.5 s`);

  // ── C2  One D-pad move in the Scenes grid ──────────────
  await switchTab('nav-scenes');
  await waitFor(() => registry.has('video-1'));
  focus('video-1');
  await sleep(300);
  const before = getCurrentFocusId();
  const move = await stopwatch(() => press('ArrowRight'), 250);
  const after = getCurrentFocusId();
  // Without this, a key the routing ignores would "cost 0 commits" and pass.
  check('C2a ArrowRight actually moved focus', !!before && after !== before,
    `${before} → ${after}`);
  check('C2 one grid focus move stays cheap', move <= 8, `${move} commit(s) for one ArrowRight`);

  // ── C3  A tab switch is a remount, not a storm ─────────
  // The arriving page mounts its first page of cards; a commit per card per
  // render pass would be dozens. The bound is the card count's neighbourhood,
  // so a genuine per-card storm still trips it.
  const tab = await stopwatch(() => switchTab('nav-performers'), 900);
  check('C3 a tab switch costs one page mount', tab <= 40, `${tab} commit(s) for Scenes → Performers`);

  check('C4 no uncaught errors', errors.length === 0, errors.slice(-2).join(' | ') || 'none');
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
document.body.style.margin = '0';

// Before the render, so the first fetch already sees the fake endpoint.
setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(root).render(
  <Profiler id="app" onRender={onRender}>
    <App />
  </Profiler>,
);

run()
  .then(finish)
  .catch(async (e) => {
    results.push({
      name: 'driver crashed',
      pass: false,
      detail: (e && e.stack) || String(e),
    });
    await finish();
  });
