/**
 * Headless driver for Back from a performer opened on a scene detail.
 *
 * Scenes -> a scene -> its performer chip -> Back must return to the Scenes
 * listing on the scene card the chain started from. The listing remounts on
 * the tab change (TabContent swaps the page and the tab change clears the list
 * caches), so the card is restored by id through focus.js, not by element.
 *
 * The first card is where the fallback lands, so the scene opened is not 1.
 *
 * A headless driver cannot prove the TV's remote sends the same keydown; that
 * is the TV pass.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry, getCurrentFocusId } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';
import { isRestorePending } from '../../src/utils/restorePending.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const active = () => document.activeElement || document.body;

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

async function pressBack() {
  active().dispatchEvent(new KeyboardEvent('keydown', {
    keyCode: 10009, key: 'Escape', bubbles: true, cancelable: true,
  }));
}

async function waitFor(fn, ms = 6000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* still settling */ }
    await sleep(step);
  }
  return false;
}

const railActive = () =>
  document.querySelector('[aria-current="page"]')?.textContent.trim() || '(none)';
const performerPageOpen = () =>
  !!document.querySelector('button[aria-label="Back to performers"]');

async function run() {
  // ── Scenes listing ───────────────────────────────────────
  const onRail = await waitFor(() => registry.has('nav-scenes'), 6000);
  focus('nav-scenes');
  await sleep(120);
  await tapEnter();
  const onScenes = await waitFor(() => registry.has('video-2'), 6000);
  check('S-1 the Scenes grid is the surface under test', onRail && onScenes,
    `rail ${railActive()}`);

  // Not the first card: landing on video-1 is the failure this checks for.
  focus('video-2');
  await sleep(120);
  await tapEnter();
  const detailUp = await waitFor(() => registry.has('scene-performer-1'), 6000);
  check('S-2 the scene detail shows its performer chip', detailUp,
    detailUp ? 'chip scene-performer-1 present' : `focus ${getCurrentFocusId()}`);

  // ── Performer chip ───────────────────────────────────────
  focus('scene-performer-1');
  await sleep(120);
  await tapEnter();
  const performerUp = await waitFor(performerPageOpen, 6000);
  check('S-3 the chip opens the performer page', performerUp,
    `rail ${railActive()}, focus ${getCurrentFocusId()}`);

  // ── Back ─────────────────────────────────────────────────
  await sleep(250);   // let the performer page settle before Back
  const t0 = Date.now();
  await pressBack();
  const timeline = [];
  for (let i = 0; i < 110; i++) {
    const id = getCurrentFocusId();
    const pending = isRestorePending();
    const last = timeline[timeline.length - 1];
    if (!last || last.id !== id || last.pending !== pending || last.has2 !== registry.has('video-2')) {
      timeline.push({
        t: Date.now() - t0, id, pending,
        has2: registry.has('video-2'), rail: railActive(),
      });
    }
    // A page-1 card: 1.5 s is already the failure case, so stop there.
    if (id === 'video-2' || Date.now() - t0 > 1500) break;
    await sleep(50);
  }
  const backOnScenes = railActive() === 'Scenes' && registry.has('video-2');
  const focusId = getCurrentFocusId();
  check('S-4 Back returns to the Scenes listing', backOnScenes,
    `rail ${railActive()}`);
  check('S-5 Back lands on the scene card the chain started from',
    focusId === 'video-2',
    `focus ${focusId} after ${Date.now() - t0} ms; `
    + JSON.stringify(timeline.slice(0, 14)));

}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

const rootEl = document.getElementById('root');
rootEl.style.cssText = 'height:100vh;display:flex;flex-direction:column;overflow:hidden;';
document.body.style.margin = '0';

// Before the render, so the first fetch already sees the fake endpoint.
setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(rootEl).render(<App />);

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
