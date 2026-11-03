/**
 * Headless driver for the Groups tab and the trip a group card starts.
 *
 * Two things only this driver can see:
 *
 *   - artwork. Stash answers a group with no cover using one shared placeholder
 *     marked `default=true`: a 200, so it is neither an absent field nor an
 *     `onError`. Treating it as a picture put the same icon on every card. The
 *     fixture serves all three shapes: a real cover (group 1), the placeholder
 *     plus a scene screenshot (group 3), and nothing at all (group 6, the
 *     monogram).
 *   - Back. A group card opens Scenes filtered by that group; Back must return
 *     to the Groups tab with the cursor on the card that was pressed, not the
 *     first card of the listing it remounts.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
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

async function getJSON(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return r.json();
}

// Cards activate on keydown, but send the keyup too so one helper serves the
// rail and the cards alike.
async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(150);
}

async function pressBack() {
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', keyCode: 10009, which: 10009, bubbles: true, cancelable: true,
  }));
  await sleep(450);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};

// Cards carry no DOM id and their classes are hashed; the registry is the only
// name they have.
const focusId = () => Array.from(registry.entries())
  .find(([, e]) => e.el === document.activeElement)?.[0] || null;

const onScreen = (id) => {
  const el = registry.get(id)?.el;
  return !!el && document.contains(el);
};

const cardSrc = (id) => (onScreen(id)
  ? registry.get(id).el.querySelector('img')?.getAttribute('src') || null
  : null);

const hasMonogram = (id) => onScreen(id)
  && !!registry.get(id).el.querySelector('[class*="imgFallback"]');

// A scene listing's criterion travels as `scene_filter`. `value` is ids or
// `{id,label}` rows depending on the translation, so accept both.
const groupIdsIn = (req) => {
  const v = req.scene_filter && req.scene_filter.groups && req.scene_filter.groups.value;
  return (Array.isArray(v) ? v : [])
    .map(x => String(x && typeof x === 'object' ? x.id : x));
};
const countGroupScenes = async (id) => (await getJSON('/requests'))
  .filter(r => groupIdsIn(r).includes(id)).length;
const groupScenesFor = async (id) => (await countGroupScenes(id)) > 0;

// The Filter dropdown carries no DOM id; its label sits just before it.
const filterTriggerText = () => {
  const label = Array.from(document.querySelectorAll('[class*="controlLabel"]'))
    .find(el => el.textContent.trim() === 'Filter');
  return (label?.nextElementSibling?.querySelector('button')?.textContent || '').trim();
};

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

async function run() {
  // Wait for the app's first screen, or the rail press races the mount.
  await waitFor(() => registry.has('showroom-recent-scenes-video-1'), 8000);
  await sleep(300);

  focus('nav-groups');
  await tapEnter();
  const groupsUp = await waitFor(() => onScreen('group-1'), 6000);
  check('G1 the Groups tab lists group cards', groupsUp,
    groupsUp ? 'group-1 on screen' : 'no group card after the rail press');
  if (!groupsUp) return;

  // ── artwork ───────────────────────────────────────────────
  const cover1 = cardSrc('group-1');
  check('G2 a group with a real cover keeps it',
    /\/group\/1\/image\.png/.test(cover1 || '') && !/default=true/.test(cover1 || ''),
    `src=${cover1}`);

  // The placeholder is a 200, so only its flag says it is not a picture.
  const cover3 = cardSrc('group-3');
  check('G3 the shared placeholder falls back to the group\'s scene screenshot',
    /\/scene\/903\/thumb\.png/.test(cover3 || ''),
    `src=${cover3}`);

  check('G4 a group with no picture at all shows the monogram',
    !cardSrc('group-6') && hasMonogram('group-6'),
    `src=${cardSrc('group-6')} monogram=${hasMonogram('group-6')}`);

  // ── the trip a group card starts ──────────────────────────
  const card2 = registry.get('group-2')?.el;
  check('G5 the card under test is on screen', !!card2 && document.contains(card2));
  if (!card2) return;

  card2.focus();
  await sleep(120);
  await tapEnter();

  // The applied criterion is visible only on the scene listing's own request:
  // `FindGroups` logs a top-level `group_filter` too, so checking that key
  // passes on the Groups tab's own listing and proves nothing.
  const filtered = await waitFor(() => groupScenesFor('2'), 5000);
  check('G6 pressing a group card opens Scenes filtered by it', filtered,
    `scene listings carrying group 2=${await countGroupScenes('2')}`);
  await waitFor(() => onScreen('video-1'), 5000);

  // ── Back lands on the card that was pressed ───────────────
  await pressBack();
  const groupsBack = await waitFor(() => onScreen('group-1'), 5000);
  check('G7 Back returns to the Groups tab', groupsBack);

  const originFocused = await waitFor(
    () => document.activeElement === registry.get('group-2')?.el, 4000,
  );
  check('G8 ...with the cursor on the card that was pressed, not the first',
    originFocused,
    `active=${focusId() || document.activeElement?.tagName}`);

  check('G9 no uncaught errors', errors.length === 0,
    errors.length ? errors.slice(-2).join(' | ') : 'none');

  // ── Back from a scene detail's Groups chip ────────────────
  // This is the trip the user reported: Scenes → open a scene → tap a Groups
  // chip → Scenes filtered by that group → Back. Unlike the card's trip above,
  // the tab never changes, so nothing remounts and the restore has to survive
  // the listing resetting in place. Before the fix it landed on the first card.
  focus('nav-scenes');
  await sleep(120);
  await tapEnter();

  const gridUp = await waitFor(() => onScreen('video-5'), 6000);
  const card5 = registry.get('video-5')?.el;
  check('G10 the Scenes grid is back for the same-tab trip', gridUp && !!card5);
  if (!card5) return;

  card5.focus();
  await sleep(120);
  await tapEnter();
  const chipUp = await waitFor(() => registry.has('scene-group-2'), 6000);
  check('G11 the scene opens with its Groups chips', chipUp);
  if (!chipUp) return;

  await fetch(`http://127.0.0.1:${PORT}/clear`, { method: 'POST' });
  registry.get('scene-group-2').el.focus();
  await sleep(80);
  await tapEnter();
  const chipFiltered = await waitFor(() => groupScenesFor('2'), 5000);
  check('G12 the group chip opens Scenes filtered by that group', chipFiltered,
    `scene listings carrying group 2=${await countGroupScenes('2')}`);

  // The applied filter is what the dropdown names; Back must restore the
  // listing as it was left, which for this origin had no filter.
  await waitFor(() => /VERIFY group 2/.test(filterTriggerText()), 4000);
  check('G12a the Scenes dropdown names the group filter',
    /VERIFY group 2/.test(filterTriggerText()),
    `dropdown reads "${filterTriggerText()}"`);

  // Cleared before Back so the listing the restore repaints is the only one
  // logged: a refetch still carrying group 2 means the filter survived.
  await fetch(`http://127.0.0.1:${PORT}/clear`, { method: 'POST' });
  await pressBack();
  const gridRestored = await waitFor(() => onScreen('video-5'), 5000);
  await waitFor(async () => (await getJSON('/requests'))
    .some(r => 'scene_filter' in r && r.page === 1), 3000);
  const groupAfterBack = await countGroupScenes('2');
  check('G13 Back returns to the unfiltered Scenes grid',
    gridRestored && groupAfterBack === 0,
    `video-5=${gridRestored} scene listings still carrying group 2=${groupAfterBack} `
      + `dropdown reads "${filterTriggerText()}"`);

  const originBack = await waitFor(
    () => document.activeElement === registry.get('video-5')?.el, 4000,
  );
  check('G14 ...with the cursor on the scene card, not the first',
    originBack,
    `active=${focusId() || document.activeElement?.tagName}`);

  check('G15 no uncaught errors on the same-tab trip', errors.length === 0,
    errors.length ? errors.slice(-2).join(' | ') : 'none');
}

const root = document.getElementById('root');
document.body.style.margin = '0';

// Before the render, so the first fetch already sees the fake endpoint.
setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(root).render(<App />);

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
