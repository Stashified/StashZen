/**
 * Headless driver for the paginated list views.
 *
 * Asserts the observable contract — which pages are requested, with which
 * variables, and what the user sees — not any internal of `usePagedList`.
 * Chosen with `?view=grid` (default), `markers`, `performers`, `carousel`,
 * `coverflow` or `list`: the grids and List watch an IntersectionObserver
 * sentinel; the strips watch how near the focused index is to the loaded end.
 *
 * It mounts the listing components directly, so it cannot see whether a page
 * dispatches to them — `views-entry.jsx` mounts App for that. The three grids
 * differ only in the count noun and the focus-id prefix, so `VIEWS` holds
 * those and one `runGrid` serves them.
 */

import { createRoot } from 'react-dom/client';
import { useState, useEffect } from 'react';
import VideoGrid from '../../src/components/VideoGrid.jsx';
import Carousel from '../../src/components/Carousel.jsx';
import VideoCoverflow from '../../src/components/VideoCoverflow.jsx';
import { SCENE_VIEW } from '../../src/components/carouselViews.js';
import MarkerGrid from '../../src/components/MarkerGrid.jsx';
import PerformerGrid from '../../src/components/PerformerGrid.jsx';
import ItemList from '../../src/components/ItemList.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const VIEW = new URLSearchParams(location.search).get('view') || 'grid';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The fake listing is 100 rows at a page size of 40 — see SCENE_COUNT,
// MARKER_COUNT and PERFORMER_COUNT in server.py.
const TOTAL = 100;
const PAGE_SIZE = 40;

// The grid under test: `noun` in the count line/end marker; `focus` is the
// registry prefix (absent → "undefined1" and every walk check red). `mode` is
// pushed before the first render; markers needs it for the two-row fixture.
const VIEWS = {
  grid:       { kind: 'grid',  t: 'G', noun: 'videos',     focus: 'video-' },
  markers:    { kind: 'grid',  t: 'M', noun: 'markers',    focus: 'marker-',
                mode: { markers: 'paged' } },
  performers: { kind: 'grid',  t: 'P', noun: 'performers', focus: 'performer-' },
  // One-column List keeps the grid's contract — `[role="grid"]`, one focus id
  // per row, sentinel and end marker — so `runGrid` applies; only the layout
  // check knows it is a list.
  list:       { kind: 'grid',  t: 'L', noun: 'videos',     focus: 'video-' },
  carousel:   { kind: 'strip', t: 'C', noun: 'videos',     focus: 'video-' },
  coverflow:  { kind: 'strip', t: 'F', noun: 'videos',     focus: 'video-' },
};
const V = VIEWS[VIEW] || VIEWS.grid;

// Asserted rather than left to the reader: an absent prefix does not throw, it
// makes `focusCard` look up a key no card has. This line replaces fourteen
// cascading failures phrased as though the app were at fault.
check(`${V.t}0 the view declares a focus prefix the walk can resolve`,
  !!V.focus, `focus = ${JSON.stringify(V.focus)}`);

const DEFAULT_CONTROLS = {
  mode: 'classic', sort: 'created_at', order: 'desc', cols: 4, filterId: null, search: '',
};

// ── Server-side request log ─────────────────────────────────
// The row count cannot tell "asked for page 2" from "asked twice" — the failure
// mode a mis-wired in-flight guard produces.
const log = () => fetch('/requests').then(r => r.json());
const clearLog = () => fetch('/clear', { method: 'POST' });
const setMode = (patch) => fetch('/mode', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
});

// A compact, diffable fingerprint of a request log.
const pagesOf = (rows) => rows.map(r => `${r.page}@${r.per_page}:${r.sort}:${r.direction}${r.q ? `:q=${r.q}` : ''}`);

// ── Layout helpers ──────────────────────────────────────────
// `.gridWrapper { flex: 1; overflow-y: auto }` needs a height-constrained flex
// column above it; the harness page has no app shell, so the driver supplies one.
const scrollRoot = () => document.querySelector('[role="grid"]')?.parentElement;
const rowCount = () => document.querySelector('[role="grid"]')?.children.length ?? -1;
// The wrapper holds the grid plus one tail element, and which tail it is is
// the end-of-list state: a sentinel while more may exist, an end marker once
// every row is loaded. Counting children avoids hashed class names.
const tailIsSentinel = () => scrollRoot()?.children.length === 2 && !endMarkerShown();
const endMarkerShown = () =>
  (scrollRoot()?.textContent || '').includes(`${TOTAL} ${V.noun} loaded`);
// The count line (ListStats) is a sibling of the scroller, reached via
// `data-list-stats` (class names are hashed). It renders nothing without
// `total`; a fallback selector once matched a card title, so `?? ''` is deliberate.
const countLineText = () =>
  scrollRoot()?.parentElement?.querySelector('[data-list-stats]')?.textContent ?? '';

async function toBottom() {
  const el = scrollRoot();
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  // The observer fires from a rAF-ish callback; one frame is not enough.
  await sleep(400);
}

// Focus a card by asking the real focus registry where it is. The cards
// carry no DOM id, so this is the only handle on them.
const focusCard = (id) => {
  const entry = registry.get(`${V.focus}${id}`);
  if (entry) entry.el.focus();
  return !!entry;
};

// Each grid names its select handler differently, and React would warn on an
// unknown prop, so the branches below stay explicit rather than spreading a
// generic `onSelect`.
function Harness() {
  const [controls, setControls] = useState(DEFAULT_CONTROLS);
  const [search, setSearch] = useState('');

  useEffect(() => {
    window.__setSort = (sort) => setControls(c => ({ ...c, sort }));
    window.__setSearch = setSearch;
  }, []);

  const common = { controls, objectFilter: null, searchQuery: search };

  // The scene descriptor ScenesPage really hands the carousel, so these checks
  // exercise the app's `view` rather than a fixture built to suit the driver.
  if (VIEW === 'carousel')   return <Carousel {...common} view={SCENE_VIEW} />;
  if (VIEW === 'coverflow')  return <VideoCoverflow {...common} />;
  if (VIEW === 'list')       return <ItemList {...common} view={SCENE_VIEW} onSelect={() => {}} />;
  if (VIEW === 'markers')    return <MarkerGrid {...common} onMarkerSelect={() => {}} />;
  if (VIEW === 'performers') return <PerformerGrid {...common} onPerformerSelect={() => {}} />;
  return <VideoGrid {...common} onVideoSelect={() => {}} />;
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

// ── The grid: observer-triggered paging ────────────────────
async function runGrid() {
  const t = V.t;
  const noun = V.noun;
  await sleep(600);
  const first = await log();
  check(`${t}1 page 1 rendered`, rowCount() === PAGE_SIZE, `${rowCount()} rows`);
  check(`${t}1 the count line names what is loaded against the total`,
    countLineText() === `40 of 100 ${noun}`, countLineText());
  check(`${t}1 exactly one request`, first.length === 1, pagesOf(first).join(', '));
  check(`${t}1 it was page 1 with the caller's sort and order`,
    first[0]?.page === 1 && first[0]?.sort === 'created_at' && first[0]?.direction === 'DESC',
    JSON.stringify(first[0]));

  // Only List can answer these: the grid is four columns. The mode must change
  // the shape (rows stacked, full width), not render one card per line by
  // accident or shrink-wrap each row.
  if (VIEW === 'list') {
    const rows = [...document.querySelectorAll('[role="grid"] > button')];
    const a = rows[0]?.getBoundingClientRect();
    const b = rows[1]?.getBoundingClientRect();
    const root = scrollRoot();
    const innerW = root
      ? root.clientWidth - parseFloat(getComputedStyle(root).paddingLeft)
        - parseFloat(getComputedStyle(root).paddingRight)
      : 0;
    check(`${t}1 the listing renders as a list, not a grid`,
      !!document.querySelector('[role="grid"][data-list-mode]')
        && rows.length >= 2 && !!a && !!b && b.top > a.top && Math.abs(a.left - b.left) < 2,
      `${rows.length} rows; left ${a?.left}→${b?.left}, top ${a?.top}→${b?.top}`);
    check(`${t}1 each row is one full-width line`,
      !!a && innerW > 0 && Math.abs(a.width - innerW) <= 2,
      `row ${a?.width}px in a ${innerW}px scroller`);
    check(`${t}1 rows keep the scene focus ids the queue and the harness use`,
      !!registry.get(`${V.focus}1`) && !!registry.get(`${V.focus}2`),
      `${V.focus}1=${!!registry.get(`${V.focus}1`)} ${V.focus}2=${!!registry.get(`${V.focus}2`)}`);
  }

  // ── Reaching the bottom loads exactly one more page ──────
  await toBottom();
  const afterTwo = await log();
  check(`${t}2 bottom asked for page 2`, afterTwo.length === 2 && afterTwo[1].page === 2,
    pagesOf(afterTwo).join(', '));
  check(`${t}2 page 2 appended rather than replaced`, rowCount() === PAGE_SIZE * 2, `${rowCount()} rows`);
  check(`${t}2 the count line moved with the list`, countLineText() === `80 of 100 ${noun}`, countLineText());

  // ── And stops once the short last page lands ─────────────
  await toBottom();
  const afterThree = await log();
  check(`${t}3 bottom asked for page 3`, afterThree.length === 3 && afterThree[2].page === 3,
    pagesOf(afterThree).join(', '));
  check(`${t}3 the short page completes the list`, rowCount() === TOTAL, `${rowCount()} of ${TOTAL} rows`);
  check(`${t}3 the end marker replaced the sentinel`,
    endMarkerShown() && !tailIsSentinel(), `tail is sentinel: ${tailIsSentinel()}`);
  // Stops saying "N of N" once every row is in — see ListStats.
  check(`${t}3 the count line stops repeating itself once the list is whole`,
    countLineText() === `100 ${noun}`, countLineText());

  // ── No page 4 ───────────────────────────────────────────
  // The sentinel is gone, but the scroll root is still scrolled to the
  // bottom, so if the stop condition were wrong this is where it would fire.
  await toBottom();
  await sleep(400);
  const afterFour = await log();
  check(`${t}4 nothing past the end is requested`, afterFour.length === 3, pagesOf(afterFour).join(', '));

  // ── A new request identity resets to page 1 ─────────────
  scrollRoot().scrollTop = 0;
  await clearLog();
  window.__setSort('title');
  await sleep(600);
  const afterReset = await log();
  check(`${t}5 a sort change refetches page 1`, afterReset.length === 1 && afterReset[0].page === 1,
    pagesOf(afterReset).join(', '));
  check(`${t}5 the refetch carries the new sort`, afterReset[0]?.sort === 'title',
    `sort=${afterReset[0]?.sort}`);
  check(`${t}5 the list was replaced, not appended to`, rowCount() === PAGE_SIZE, `${rowCount()} rows`);

  // ── G9  a reset must not steal focus from where the user is ──
  // A fresh screen autofocuses the first card, but a reset (search, sort,
  // filter) must not steal it from the search field or controls trigger.
  const bystander = document.createElement('button');
  bystander.textContent = 'search stand-in';
  bystander.setAttribute('tabindex', '0');
  document.body.appendChild(bystander);
  bystander.focus();
  window.__setSearch('VERIFY scene 17');
  await sleep(700);
  check(`${t}9 the search replaced the rows under the focused control`,
    rowCount() === 1, `${rowCount()} row(s)`);
  check(`${t}9 a listing reset leaves focus where the user put it`,
    document.activeElement === bystander,
    `activeElement="${(document.activeElement?.textContent || '').slice(0, 24)}"`);

  // The other half, or the check above would pass on a build that never
  // auto-focuses anything: with nothing focused, the new first card takes it.
  bystander.blur();
  window.__setSearch('VERIFY scene 18');
  await sleep(700);
  check(`${t}9 with nothing focused the new first card still claims it`,
    document.activeElement === registry.get(`${V.focus}18`)?.el,
    `activeElement="${(document.activeElement?.textContent || '').slice(0, 24)}"`);
  bystander.remove();
  window.__setSearch('');
  await sleep(500);

  // ── A page that lands after a reset is dropped ──────────
  // Without the requestId guard the old list's page 2 splices into the new
  // list. Only page 2 is delayed: a slow replacement would land last and hide it.
  //
  // Scenes and List only: `slow-page-2` is a findScenes mode the marker and
  // performer handlers lack, so those views say they skipped rather than run
  // vacuously.
  if (VIEW !== 'grid' && VIEW !== 'list') {
    check(`${t}6 the late-page race is scene-only`, true,
      `skipped on ${VIEW}: the server delays findScenes only`);
    return;
  }
  await setMode({ findScenes: 'slow-page-2' });
  await clearLog();
  await toBottom();                    // page 2 of 'title' goes out, 1s late
  scrollRoot().scrollTop = 0;          // ... out of the sentinel's reach, so
                                       // the new list doesn't page on its own
  window.__setSort('rating');          // the list moves on underneath it
  await sleep(2000);
  await setMode({ findScenes: 'ok' });
  const afterRace = await log();
  check('G6 the reset still asked for page 1 of the new sort',
    afterRace.some(r => r.page === 1 && r.sort === 'rating'), pagesOf(afterRace).join(', '));
  check('G6 the late page from the old list was discarded',
    rowCount() === PAGE_SIZE, `${rowCount()} rows (80 would mean it was appended)`);

  // ── G7  the reset must not wedge paging ──────────────────
  // A reset used to leave `loadingMore` set, so the discarded page's `finally`
  // skipped it with a stale id and every later loadMore hit the guard.
  await toBottom();
  await sleep(800);
  const afterRaceMore = await log();
  check('G7 paging still works after the reset',
    afterRaceMore.some(r => r.page === 2) && rowCount() === PAGE_SIZE * 2,
    `${rowCount()} rows; ${pagesOf(afterRaceMore)}`);

  // ── G8  a failed load-more is retried, then reported ─────
  // MAX_PAGE_ATTEMPTS (3) at RETRY_DELAY_MS (3000) apart, then the list stops
  // with the error visible; only a new sort asks again (pages are cached).
  scrollRoot().scrollTop = 0;
  window.__setSort('duration');
  await sleep(700);
  await setMode({ findScenes: 'fail-page-2' });
  await clearLog();
  await toBottom();                    // page 2 goes out and is refused
  // Three attempts, three seconds apart: the last lands about six seconds in.
  // Do not shorten this wait — it is the budget being tested, and a shorter
  // one would pass whether the hook retried twice or never retried at all.
  await sleep(10500);
  const failed = await log();
  const p2s = failed.filter(r => r.page === 2);
  check('G8 the refused page was retried twice, then stopped', p2s.length === 3,
    `${p2s.length} page-2 request(s): ${pagesOf(failed)}; rows=${rowCount()}; `
    + `scroll=${scrollRoot()?.scrollTop}/${scrollRoot()?.scrollHeight}`);
  check('G8 …and the error is shown beside the rows',
    document.body.textContent.includes('VERIFY page 2 refused'),
    document.body.textContent.includes('VERIFY page 2 refused') ? '' : 'no error line');
  await setMode({ findScenes: 'ok' });

  // ── B1  a page that adds no rows ends the list ───────────
  // A page that added none of its promised rows used to advance the counter, so
  // the observer asked forever; stop there. 'updated_at' keeps cache out.
  scrollRoot().scrollTop = 0;
  window.__setSort('updated_at');
  await sleep(700);
  await setMode({ findScenes: 'empty-page-2' });
  await clearLog();
  await toBottom();                    // page 2 goes out and comes back empty
  await sleep(1200);
  scrollRoot().scrollTop = 0;          // cross the sentinel back out...
  await sleep(300);
  await toBottom();                    // ...and in again, re-arming the observer
  await sleep(1200);
  const noProgress = await log();
  const empty2 = noProgress.filter(r => r.page === 2);
  const afterEmpty = noProgress.filter(r => r.page === 3);
  check(`${t}10 a page that added no rows was asked for once`,
    empty2.length === 1, pagesOf(noProgress).join(', '));
  check(`${t}10 …and the list stopped there instead of walking pages`,
    afterEmpty.length === 0 && rowCount() === PAGE_SIZE,
    `${afterEmpty.length} page-3 request(s); ${rowCount()} rows`);
  await setMode({ findScenes: 'ok' });
}

// ── The carousel / coverflow: focus-proximity paging ───────
// One driver for both: they page identically; coverflow's extra focus-in-rail
// tracking is presentation.
async function runFocusWalk() {
  const t = V.t;
  await sleep(600);
  check(`${t}1 page 1 requested`, (await log()).length === 1, pagesOf(await log()).join(', '));
  check(`${t}1 the hero shows the first row`,
    document.body.textContent.includes('VERIFY scene 1'));

  // Step one card at a time: only cards within 4 of the focused index are
  // mounted, so the next must exist before it can be focused. The trigger
  // fires within LOAD_MORE_THRESHOLD (8) of the 40 loaded rows.
  let landed = 0;
  for (let i = 0; i < 36; i++) {
    if (focusCard(String(i + 1))) landed++;
    await sleep(45);
  }
  check(`${t}2 the whole strip was walkable`, landed === 36, `${landed} cards focused`);
  check(`${t}2 the hero followed the focus`,
    document.body.textContent.includes('VERIFY scene 36'),
    `hero reads "${(document.querySelector('[class*="heroTitle"]')?.textContent || '').slice(0, 30)}"`);

  await sleep(600);
  const rows = await log();
  check(`${t}3 nearing the end asked for exactly one more page`,
    rows.length === 2, pagesOf(rows).join(', '));
  check(`${t}3 and it was page 2`, rows[1]?.page === 2, pagesOf(rows).join(', '));
  check(`${t}3 the request carries the caller's sort and order`,
    rows[1]?.sort === 'created_at' && rows[1]?.direction === 'DESC',
    JSON.stringify(rows[1]));

  // ── Walking to the very end must not page again ─────────
  // The grid unmounts its sentinel; the strip has none, so only the stop
  // condition can refuse the trigger that re-runs on every focus change.
  for (let i = 36; i < 95; i++) {
    focusCard(String(i + 1));
    await sleep(35);
  }
  await sleep(900);
  const toEnd = await log();
  check(`${t}5 the last short page completed the list`,
    toEnd.length === 3 && toEnd[2].page === 3, pagesOf(toEnd).join(', '));
  check(`${t}5 walking the loaded tail requested nothing further`,
    toEnd.length === 3, pagesOf(toEnd).join(', '));

  // ── A new request identity resets to page 1 ─────────────
  await clearLog();
  window.__setSort('title');
  await sleep(600);
  const afterReset = await log();
  check(`${t}4 a sort change refetches page 1`,
    afterReset.length === 1 && afterReset[0].page === 1, pagesOf(afterReset).join(', '));
  check(`${t}4 the refetch carries the new sort`, afterReset[0]?.sort === 'title',
    `sort=${afterReset[0]?.sort}`);
  check(`${t}4 the hero went back to the top`,
    document.body.textContent.includes('VERIFY scene 1'));

  // ── C6  a refused page is retried on a budget, not per focus step ─
  // The trigger is an effect on every focus move, so without a budget a refusal
  // became one request per step. A fresh sort keeps page 2 out of the cache.
  await clearLog();
  window.__setSort('duration');
  await sleep(600);
  await setMode({ findScenes: 'fail-page-2' });
  await clearLog();
  // 40 focus steps: the trigger fires once the focused index is within 8 of
  // the 40 loaded rows, i.e. from card 33 onward.
  for (let i = 0; i < 40; i++) {
    focusCard(String(i + 1));
    await sleep(40);
  }
  // The first refusal lands around card 33; the two retries follow three
  // and six seconds later. Wait past the budget — a shorter wait would not
  // distinguish a bounded retry from none.
  await sleep(10000);
  const failedC = await log();
  const refused = failedC.filter(r => r.page === 2);
  check(`${t}6 the refused page was retried twice, not once per focus step`,
    refused.length === 3, `${refused.length} page-2 request(s): ${pagesOf(failedC)}`);
  check(`${t}6 …and the error is shown beside the rows`,
    document.body.textContent.includes('VERIFY page 2 refused'),
    document.body.textContent.includes('VERIFY page 2 refused') ? '' : 'no error line');
  await setMode({ findScenes: 'ok' });
}

const root = document.getElementById('root');
root.style.cssText = 'height:100vh;display:flex;flex-direction:column;overflow:hidden;';
document.body.style.margin = '0';

const run = V.kind === 'strip' ? runFocusWalk : runGrid;

(async () => {
  // Before the render, so the first fetch sees the fake endpoint: `runQuery`
  // reads settings per request, but the request leaves from the mount effect,
  // which React may flush before the next line.
  setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

  // Also before the render, and awaited: otherwise the mount effect's fetch
  // races an in-flight `/mode` and the driver asserts against the default reply
  // while believing it asked for the other one.
  if (V.mode) await setMode(V.mode);

  createRoot(root).render(<Harness />);

  try {
    await run();
    check('view under test', true, VIEW);
    await finish();
  } catch (e) {
    results.push({
      name: 'HARNESS CRASHED',
      pass: false,
      detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
    });
    try { await finish(); } catch { /* nothing left to do */ }
  }
})();
