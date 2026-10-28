/**
 * Headless driver for the Search tab.
 *
 * Mounts the whole `App`: the page's claims are mostly about other components,
 * that a performer is drawn with the performer card and not the scene card,
 * that activating a result lands in the right tab, and that Back returns to
 * the same results.
 *
 * The TV keyboard cannot be raised headlessly, so typing sets the input's
 * value and fires `input`, the same commit path the IME reaches. The 300 ms
 * debounce is real and waited for.
 *
 *   Q1     the rail's last row opens the field
 *   Q2     one query fills all four sections
 *   Q2b    Down from the field goes to the first result
 *   Q3/Q4  performers are performer cards; scenes stay scene cards
 *   Q5     tags and studios use their entity cards and images
 *   Q5b    Down from a performer row reaches the tags
 *   Q6     a section with more matches offers See all
 *   Q7     Enter on a performer opens the performer
 *   Q8     Back returns to the results with the card focused
 *   Q9     See all opens that section with the query applied
 *   Q10    Back from that listing returns to the results
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

const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});
const errorTail = () => (errors.length ? errors.slice(-2).join(' | ') : 'none');

async function waitFor(pred, ms = 6000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(150);
}

// Arrows go through the window-level nav handler, which throttles held keys.
async function pressKey(key) {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await sleep(140);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }),
  );
  await sleep(140);
}

async function pressBack() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', {
    keyCode: 10009, key: 'Escape', bubbles: true, cancelable: true,
  }));
  await sleep(400);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};
// The registry outlives unmounted cards, so a key alone is not "on screen".
const live = (id) => {
  const el = registry.get(id)?.el;
  return !!el && document.contains(el);
};
const focusedId = () => getCurrentFocusId();
const railActive = () =>
  [...(document.querySelector('nav[aria-label="Main navigation"]')?.querySelectorAll('button') ?? [])]
    .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || '(none)';
const getJSON = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();

async function goto(tab) {
  focus(`nav-${tab}`);
  await sleep(120);
  await tapEnter();
  await sleep(400);
}

// The native setter, because React's controlled-input tracker swallows a plain
// `input.value =`. Then wait out the field's debounce and the fetches.
async function typeQuery(text) {
  const input = document.querySelector(
    'input[placeholder="Search scenes, performers, tags, studios"]',
  );
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value',
  ).set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(700);
  return true;
}

const QUERY = 'VERIFY';
const srcOf = (id) => registry.get(id)?.el?.querySelector('img')?.getAttribute('src') || '';

function finish() {
  return fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  }).then(() => fetch('/done', { method: 'POST' }));
}

// ── The run ─────────────────────────────────────────────────
async function run() {
  await waitFor(() => registry.has('showroom-recent-scenes-video-1'));
  await sleep(300);

  // ── Q1  the rail row opens the field ────────────────────
  await goto('search');
  const fieldUp = await waitFor(() => live('search-field'));
  check('Q1 the rail row opens Search on its field',
    fieldUp && railActive() === 'Search', `field=${fieldUp}; rail=${railActive()}`);

  // ── Q2  one query fills every section ───────────────────
  const typed = await typeQuery(QUERY);
  const filled = await waitFor(() => live('video-1') && live('performer-1')
    && live('tag-1') && live('studio-1'));
  check('Q2 one query fills all four sections',
    typed && filled,
    `typed=${typed}; scenes=${live('video-1')} performers=${live('performer-1')} `
      + `tags=${live('tag-1')} studios=${live('studio-1')}; errors: ${errorTail()}`);

  // ── Q2b  the field hands Down to the first result ──────
  // Geometry would choose column 2: the field is 900 px wide and its centre
  // sits over the second card.
  focus('search-field');
  await sleep(140);
  await pressKey('ArrowDown');
  check('Q2b Down from the field goes to the first result',
    focusedId() === 'video-1', focusedId());

  // ── Q3/Q4  each section draws its own card ──────────────
  // The regression: performers fell through to the scene card, which read
  // `paths.screenshot` from a performer (a question-mark cover) and drew the
  // play glyph. The scene check is the control that the glyph is observable.
  const performerEl = registry.get('performer-1')?.el;
  check('Q3 performer results are performer cards, image and no play glyph',
    !!performerEl
      && !performerEl.querySelector('[class*="playIcon"]')
      && !performerEl.querySelector('[class*="duration"]')
      && /\/performer\/1\/image\.png/.test(srcOf('performer-1')),
    `img=${srcOf('performer-1') || '(none)'}; `
      + `play=${!!performerEl?.querySelector('[class*="playIcon"]')}`);
  check('Q4 scene results keep the scene card and its play glyph',
    !!registry.get('video-1')?.el?.querySelector('[class*="playIcon"]'),
    'the fixture serves both card types from one grid');

  check('Q5 tag and studio results use their own images',
    /\/tag\/1\/image\.png/.test(srcOf('tag-1'))
      && /\/studio\/1\/image\.png/.test(srcOf('studio-1')),
    `tag=${srcOf('tag-1') || '(none)'}; studio=${srcOf('studio-1') || '(none)'}`);

  // ── Q5b  a section hands Down to the next one ──────────
  // The focus ring lifts the card, which made same-row neighbours look lower
  // than the Tags section; Down hopped sideways instead of leaving the row.
  focus('performer-1');
  await sleep(140);
  await pressKey('ArrowDown');
  check('Q5b Down from a performer row reaches the tags',
    focusedId() === 'tag-1', focusedId());

  // The fixture's 100 rows exceed the six shown in every section.
  const seeAllIds = ['scenes', 'performers', 'tags', 'studios'];
  const seeAll = seeAllIds.filter(k => live(`search-seeall-${k}`));
  check('Q6 every section with more matches offers See all',
    seeAll.length === seeAllIds.length, `offered: ${seeAll.join(', ') || '(none)'}`);

  // ── Q7  a performer result opens the performer ──────────
  focus('performer-1');
  await sleep(150);
  await tapEnter();
  const detailUp = await waitFor(() => railActive() === 'Performers', 4000);
  const calls = await getJSON('/graphqlcalls');
  check('Q7 Enter on a performer result opens that performer',
    detailUp && calls.includes('FindPerformerDetail'),
    `rail=${railActive()}; detail query=${calls.includes('FindPerformerDetail')}`);

  // ── Q8  Back returns to the results ─────────────────────
  // The query is App state and the cards remount, so this is both "the same
  // results" and "the restore found the card again".
  await pressBack();
  const resultsBack = await waitFor(() => railActive() === 'Search'
    && live('performer-1') && live('video-1'), 6000);
  const cardFocused = await waitFor(() => focusedId() === 'performer-1', 4000);
  check('Q8 Back returns to the results with the card focused',
    resultsBack && cardFocused,
    `rail=${railActive()}; results=${resultsBack}; focus=${focusedId()}`);

  // ── Q9  See all hands the query to the section ──────────
  focus('search-seeall-scenes');
  await sleep(150);
  await tapEnter();
  const onScenes = await waitFor(() => railActive() === 'Scenes' && live('video-1'), 6000);
  const barValue = document
    .querySelector('input[placeholder="Search…"]')?.value ?? '(no bar)';
  check('Q9 See all opens that section with the query applied',
    onScenes && barValue === QUERY, `rail=${railActive()}; bar=${JSON.stringify(barValue)}`);

  // ── Q10  Back returns to the results ────────────────────
  await pressBack();
  const backAgain = await waitFor(() => railActive() === 'Search' && live('performer-1'), 6000);
  const seeAllBack = await waitFor(() => focusedId() === 'search-seeall-scenes', 4000);
  check('Q10 Back from the full listing returns to the results',
    backAgain && seeAllBack, `rail=${railActive()}; focus=${focusedId()}`);

  check('Q11 no uncaught error during the run', errors.length === 0, errorTail());
}

const root = document.getElementById('root');
document.body.style.margin = '0';

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
