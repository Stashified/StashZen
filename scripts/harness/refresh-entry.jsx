/**
 * Headless driver for "leaving a tab means reading it again".
 *
 * Server changes did not appear until a relaunch: every listing page lives in
 * a module-scoped Map (listCache.js) that outlives the `dataKey` remount, so a
 * tab switch's "fetch page 1" was a cache hit. The fix has `changeTab` in
 * App.jsx clear every list cache before the tab state moves.
 *
 *   F1  the first Scenes visit fetches its page 1
 *   F2  Home → Scenes → Home re-fetches the Recently Added shelf
 *   F3  Home → Scenes again re-fetches the Scenes page 1
 *   F4  pressing the rail's current row reloads that tab in place
 *
 * Request counting is the assertion: the server's data does not change, so a
 * re-fetch is the behaviour and a cache hit its absence. The fake logs each
 * listing request at `/requests`. Red control: remove
 * `clearAllListCaches()` from `changeTab` and F2–F4 go red, F1 stays green.
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
const getJSON = (path) => fetch(`http://127.0.0.1:${PORT}${path}`).then(r => r.json());
const clearLogs = () => fetch(`http://127.0.0.1:${PORT}/clear`, { method: 'POST' });

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

// Cards need a keyup as well (long-press moves the short action there); rail
// rows activate on keydown alone, so sending both is inert for them.
async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(150);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};

// Told apart by the `scene_filter` key: without it, other created_at shelves
// (studios, performers) answer the same page/per_page/sort shape.
// The showroom's Recently Added Scenes shelf: five cards, newest added.
const isRecentShelf = (r) => 'scene_filter' in r
  && r.page === 1 && r.per_page === 5 && r.sort === 'created_at';
// A scene listing page 1 (the Scenes tab's 40-row grid).
const isListingPage1 = (r) => 'scene_filter' in r
  && r.page === 1 && r.per_page === 40;

async function switchTab(id) {
  focus(id);
  await sleep(120);
  await tapEnter();
}

// Type the way the IME does: the native setter (a plain `input.value =` is
// swallowed by React's controlled-input tracker), one dispatch per key with a
// 180 ms gap. That is under the field's 500 ms debounce, so a whole word
// commits once; the old 300 ms timer fired between keys and refreshed the grid
// for most letters. The on-screen keyboard cannot be raised headlessly; the
// commit path below it is the shipped one.
async function typeSearch(text) {
  const input = document.querySelector('input[placeholder="Search…"]');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value',
  ).set;
  let typed = '';
  for (const ch of text) {
    typed += ch;
    setter.call(input, typed);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(180);
  }
  await sleep(700);   // the field's debounce is 500 ms
  return true;
}

async function run() {
  // Wait for the rendered card, not just the request, so the next tab press
  // does not race the mount.
  await waitFor(() => registry.has('showroom-recent-scenes-video-1'));
  await sleep(300);

  // ── F1  First visit to Scenes fetches page 1 ───────────
  // Not the regression itself; the baseline that makes F3 mean "again".
  await clearLogs();
  await switchTab('nav-scenes');
  const firstScenes = await waitFor(async () =>
    (await getJSON('/requests')).some(isListingPage1));
  const firstCount = (await getJSON('/requests')).filter(isListingPage1).length;
  check('F1 arriving at Scenes fetches page 1',
    firstScenes && firstCount >= 1,
    `page-1 listing requests=${firstCount}`);

  // ── F2  Home again re-fetches the shelf ─────────────────
  await clearLogs();
  await switchTab('nav-home');
  const shelfAgain = await waitFor(async () =>
    (await getJSON('/requests')).some(isRecentShelf));
  const shelfReqs = (await getJSON('/requests')).filter(isRecentShelf);
  check('F2 returning to Home re-fetches Recently Added Scenes',
    shelfAgain && shelfReqs.length >= 1,
    `shelf page-1 requests after returning=${shelfReqs.length} `
      + `(${JSON.stringify(shelfReqs[0] || null)})`);

  // ── F3  Scenes again re-fetches page 1 ──────────────────
  await clearLogs();
  await switchTab('nav-scenes');
  const scenesAgain = await waitFor(async () =>
    (await getJSON('/requests')).some(isListingPage1));
  const againReqs = (await getJSON('/requests')).filter(isListingPage1);
  check('F3 returning to Scenes re-fetches page 1',
    scenesAgain && againReqs.length >= 1,
    `page-1 listing requests after returning=${againReqs.length} `
      + `(${JSON.stringify(againReqs[0] || null)})`);

  // ── F4  Pressing the current rail row reloads in place ──
  // The one gesture for "the library changed while I sat here": `changeTab`
  // treats a press on the active row as an explicit reload, not a no-op.
  await clearLogs();
  await switchTab('nav-scenes');
  const reloaded = await waitFor(async () =>
    (await getJSON('/requests')).some(isListingPage1));
  const reloadReqs = (await getJSON('/requests')).filter(isListingPage1);
  check('F4 pressing the current rail row reloads the tab in place',
    reloaded && reloadReqs.length >= 1,
    `page-1 listing requests after reload=${reloadReqs.length} `
      + `(${JSON.stringify(reloadReqs[0] || null)})`);

  check('F5 no uncaught errors while switching', errors.length === 0,
    errors.slice(-2).join(' | ') || 'none');

  // ── F6  a Home read that fails says so ──────────────────
  // The shelves used to be five requests, so one could fail alone and the row
  // stayed a heading plus one line. They are one aliased document now, so a
  // failure is the whole read: what must not happen is a silent empty Home,
  // which reads exactly like an empty library.
  await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findStudios: 'fail' }),
  });
  await switchTab('nav-home');            // Home remounts, so the shelves refetch
  const failed = await waitFor(() =>
    document.body.textContent.includes('Could not load Home.'));
  check('F6 a failed Home read says so rather than looking empty',
    failed && !document.querySelector('[data-showroom-row]'),
    `${document.body.textContent.includes('Could not load Home.') ? 'message shown' : 'no message'}, `
    + `rows=${document.querySelectorAll('[data-showroom-row]').length}`);
  await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findStudios: 'ok' }),
  });

  // ── F7–F9  a search term does not travel between tabs ────
  // `controls` is shared and the arrival rule resets sort, order, filter and
  // columns; search used to survive, silently narrowing every other tab.
  await switchTab('nav-scenes');
  await waitFor(() => registry.has('video-1'));
  await clearLogs();
  const typed = await typeSearch('kitty');
  const searched = await waitFor(async () => (await getJSON('/requests'))
    .some(r => 'scene_filter' in r && r.q === 'kitty'));
  check('F7 the search box reaches the Scenes listing',
    typed && searched,
    `input ${typed}, request with q=kitty ${searched}`);

  // One commit for the word: the reported bug was a refresh per letter.
  const searchQs = (await getJSON('/requests'))
    .filter(r => 'scene_filter' in r && r.q).map(r => r.q);
  check('F7a typing below the debounce cadence commits once',
    searchQs.length === 1 && searchQs[0] === 'kitty',
    `q=${JSON.stringify(searchQs)}`);

  await clearLogs();
  await switchTab('nav-performers');
  const arrived = await waitFor(async () => (await getJSON('/requests'))
    .some(r => 'performer_filter' in r));
  const qs = (await getJSON('/requests'))
    .filter(r => 'performer_filter' in r).map(r => r.q);
  check('F8 arriving at another tab drops the search',
    arrived && qs.length > 0 && qs.every(q => !q),
    `q=${JSON.stringify(qs)}`);
  const field = document.querySelector('input[placeholder="Search…"]');
  check('F9 ...and the search box on the new tab is empty',
    (field?.value ?? null) === '',
    `value=${JSON.stringify(field?.value ?? null)}`);

  // ── F10  the search field's clear control ──────────────
  // The × only mounts with a term and is its own focus stop. It used to be
  // visible but unreachable, so the only way to clear was to erase the text
  // one key at a time.
  await switchTab('nav-scenes');
  await waitFor(() => registry.has('video-1'));
  await clearLogs();
  await typeSearch('cat');
  const clearEntry = registry.get('ctrl-search-clear');
  check('F10 a term puts the clear control on the field', !!clearEntry);

  // The control for F10b: "cat" matches no fixture title, so the grid must be
  // empty before the clear, or a grid that never filtered would pass it.
  const cardUp = () => {
    const el = registry.get('video-1')?.el;
    return !!el && document.contains(el);
  };
  const emptied = await waitFor(() => !cardUp(), 3000);
  check('F10 control: the term empties the grid', emptied,
    `video-1 on screen=${cardUp()}`);

  focus('ctrl-search');
  await sleep(80);
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent(
    'keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true },
  ));
  await sleep(250);
  check('F10a Right from the field reaches the clear control',
    document.activeElement === clearEntry?.el,
    `active=${document.activeElement?.id || document.activeElement?.tagName}`);

  if (clearEntry) {
    // Whichever way it was reached, Enter is the activation.
    clearEntry.el.focus();
    await tapEnter();
    await sleep(400);
    const value = document.querySelector('input[placeholder="Search…"]')?.value;
    // No round trip is expected: the unfiltered page 1 is still in listCache,
    // so clearing restores those rows from it. Assert what the user sees.
    const restored = await waitFor(() => cardUp(), 3000);
    check('F10b Enter clears the term and restores the unfiltered grid',
      value === '' && restored,
      `value=${JSON.stringify(value)} video-1 back=${restored}`);
    check('F10c focus is back on the field, not <body>',
      document.activeElement === registry.get('ctrl-search')?.el,
      `active=${document.activeElement?.id || document.activeElement?.tagName}`);
  }
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
