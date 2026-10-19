/**
 * Headless driver for the paginated list views.
 *
 * Written to answer one question: after the pagination was extracted into
 * usePagedList, do these components still page the way they used to? So it
 * asserts on the *observable contract* — which pages get asked for, with
 * which variables, and what the user ends up looking at — rather than on any
 * internal of the hook.
 *
 * Run it against two revisions and diff the result JSONs; identical output
 * is the evidence that the extraction was behaviour-neutral. The recipe and
 * what it taught are in PLAN.md under "Verification".
 *
 * Chosen with `?view=grid` (default), `markers`, `performers`, `carousel`,
 * `coverflow` or `list` — the two distinct trigger families: the grid (and
 * List) watch an IntersectionObserver sentinel, the other two watch how near
 * the focused index is to the end of the loaded rows. Coverflow shares the
 * carousel's driver.
 *
 * **This driver mounts the listing components directly, not a page.** It can
 * therefore see `ItemList` render and page, but it cannot see whether a page
 * dispatches to it at all: removing the list branch from `ScenesPage` leaves
 * every check here green. That hand-off is `views-entry.jsx`'s, which mounts
 * `App` and changes modes through the real control — control experiment 3 in
 * PLAN.md's P12 section is the worked example.
 *
 * `markers` and `performers` were added when those two grids were migrated
 * onto usePagedList: they are the same trigger family as `grid`, and the
 * whole point of the exercise was to diff their behaviour before and after,
 * which needs a driver that can render them. They differ from `grid` in
 * exactly three strings — the noun in the count line and end marker, and the
 * prefix of the focus-registry key — so `VIEWS` below holds those and one
 * `runGrid` serves all three. Adding a fourth grid should mean adding a row.
 *
 * The view named `random` went with RandomPage in 0.7.0 — it drove the Reels
 * feed's keypress-indexed paging, and the feed is gone.
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
// MARKER_COUNT and PERFORMER_COUNT in server.py, all 100 for this reason.
const TOTAL = 100;
const PAGE_SIZE = 40;

// Which grid is under test, and the three things that differ between them.
// `noun` appears in the count line and the end marker; `focus` is the prefix
// of the focus-registry key (`video-7`, `marker-7`, `performer-7`). Everything
// else about these three grids is the same shape — which is the finding that
// made the migration worth doing.
//
// `focus` is not optional, including for the two strips. Both of them render
// VideoCard — the carousel directly, coverflow behind its reflection — so both
// register `video-<id>` and both need the prefix here. Leaving it off does not
// fail loudly: `focusCard` builds the key `"undefined1"`, finds nothing, and
// returns false for every card, so the walk lands zero and the paging checks
// cascade red. They were declared that way until 2026-10-16, and the fourteen
// checks below had therefore never once run. `V.focus` is asserted below rather
// than trusted to the reader, because the failure is silent by construction.
//
// `mode` is pushed to the fake server before the first render. Only markers
// needs one: its default reply is the Markers tab's two deliberate rows (the
// markerfix fixture), so the paginated listing has to be asked for by name.
const VIEWS = {
  grid:       { kind: 'grid',  t: 'G', noun: 'videos',     focus: 'video-' },
  markers:    { kind: 'grid',  t: 'M', noun: 'markers',    focus: 'marker-',
                mode: { markers: 'paged' } },
  performers: { kind: 'grid',  t: 'P', noun: 'performers', focus: 'performer-' },
  // The one-column List mode. It deliberately keeps the grid's contract —
  // `[role="grid"]`, one focus id per row, the same sentinel/end marker — so
  // the same `runGrid` applies; the layout check below is the only thing that
  // knows it is a list.
  list:       { kind: 'grid',  t: 'L', noun: 'videos',     focus: 'video-' },
  carousel:   { kind: 'strip', t: 'C', noun: 'videos',     focus: 'video-' },
  coverflow:  { kind: 'strip', t: 'F', noun: 'videos',     focus: 'video-' },
};
const V = VIEWS[VIEW] || VIEWS.grid;

// Stated as a check rather than left to the reader, because the failure it
// guards is silent: an absent or misspelled prefix does not throw, it makes
// `focusCard` look up a key no card has. This is the one line that would have
// said so, at the top of the run, instead of fourteen red lines at the bottom
// all phrased as though the app were at fault.
check(`${V.t}0 the view declares a focus prefix the walk can resolve`,
  !!V.focus, `focus = ${JSON.stringify(V.focus)}`);

const DEFAULT_CONTROLS = {
  mode: 'classic', sort: 'created_at', order: 'desc', cols: 4, filterId: null, search: '',
};

// ── Server-side request log ─────────────────────────────────
// The rendered row count alone cannot tell "asked for page 2" from "asked
// for page 2 twice", and the double-request is exactly the failure mode a
// hook with a mis-wired in-flight guard produces.
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
// The grid's scroll container is `.gridWrapper { flex: 1; overflow-y: auto }`,
// so it only scrolls if its parent is a height-constrained flex column. The
// harness page has no app shell, so the driver supplies one.
const scrollRoot = () => document.querySelector('[role="grid"]')?.parentElement;
const rowCount = () => document.querySelector('[role="grid"]')?.children.length ?? -1;
// The wrapper holds exactly the grid plus one tail element, and which tail
// element it is *is* the end-of-list state: a sentinel while there may be
// more, an end marker once every row is loaded. Counting children avoids
// keying off CSS-module class names, which are hashed.
const tailIsSentinel = () => scrollRoot()?.children.length === 2 && !endMarkerShown();
const endMarkerShown = () =>
  (scrollRoot()?.textContent || '').includes(`${TOTAL} ${V.noun} loaded`);
// The count line (ListStats) is a *sibling* of the scroller, not a child of it,
// so it is reached from the grid through scrollRoot().parentElement; it is
// selected by its `data-list-stats` attribute because its class name is hashed.
// It renders nothing at all when `total` is missing — that null is the silent
// failure this check exists to catch, since a count line that never appears
// looks exactly like a screen that was never meant to have one.
//
// `?? ''` and not a fallback selector: an earlier version queried the first
// `<p>` under the page, which with the line absent matched the first card's
// title — so the check reported "VERIFY scene 1" and only failed because that
// string is not a count. A control experiment is what surfaced it.
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

  // The scene descriptor, i.e. the one ScenesPage hands the carousel for real —
  // so these checks exercise the same `view` the app passes rather than a
  // fixture built to suit the driver.
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

  // Only the list can answer these: the grid is 4 columns, so its rows sit
  // beside each other. What is being tested is that the mode actually changed
  // the *shape* rather than rendering the cards one per line by accident, and
  // that the rows are the full width of the scroller rather than shrink-wrapped
  // to their content.
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
  // The first card autofocuses so a freshly opened screen has a cursor. On a
  // *reset* — a search keystroke, a sort, a filter — that is wrong when the
  // user is somewhere else: it pulls the ring out of the search field (which
  // closes the TV keyboard) or off the controls trigger they just used. Any
  // non-<body> focus stands in for those here; the hook only asks whether the
  // active element is <body>.
  //
  // A search is what makes the reset real: it replaces the rows, so the first
  // card is a new component instance and its autofocus latch is unset. A sort
  // alone can reuse the same card node, in which case nothing would try to
  // take focus and the check would pass for no reason.
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
  // This is the requestId guard. Without it the old list's page 2 is
  // appended to the new list, and the user sees 80 rows of two different
  // orderings spliced together.
  //
  // Only page 2 is delayed, and deliberately so: if the *replacement* list
  // were slow too, its own reply would land last and overwrite the bad
  // append, leaving a final row count that looks correct either way. The
  // first version of this test did exactly that and passed against a hook
  // with the guard deleted. Delay the stale reply, not the fresh one.
  //
  // Scenes only: `slow-page-2` is a mode on the findScenes handler, and the
  // marker and performer handlers do not implement it — deliberately, since
  // the guard being exercised here lives in usePagedList, which all three
  // grids share by this point. Asking for a delay the server cannot give
  // would make this check quietly vacuous on those two views, so it is
  // skipped and *said* to be skipped rather than run and pass for nothing.
  // `list` is a scene listing too, so the server's delay applies to it and the
  // guard is exercised there rather than skipped.
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
  // The reset clears items/page/loading but used to leave `loadingMore`
  // alone. The in-flight page that the race above discarded reached its
  // `finally` with a stale id and skipped `setLoadingMore(false)`, so the
  // flag stayed true and every later `loadMore` returned at the guard —
  // infinite scroll dead, spinner up, until the view remounted. The page
  // that arrives here is the first one *after* the wedging reset.
  await toBottom();
  await sleep(800);
  const afterRaceMore = await log();
  check('G7 paging still works after the reset',
    afterRaceMore.some(r => r.page === 2) && rowCount() === PAGE_SIZE * 2,
    `${rowCount()} rows; ${pagesOf(afterRaceMore)}`);

  // ── G8  a failed load-more is reported, not retried ──────
  // The failure used to be invisible while rows existed (the error line only
  // renders at zero rows), and `setLoadingMore(false)` re-armed the observer,
  // which asked again immediately — one page-2 request after another, with
  // nothing on screen to say why. The budget is one automatic attempt per
  // request identity; a sort change is the retry.
  // A sort these earlier checks have not used yet. listService caches pages
  // by request identity, and 'title' and 'rating' both have both pages in
  // that cache by now — reusing either would load page 2 without a request
  // and prove nothing about a *failed* request.
  scrollRoot().scrollTop = 0;
  window.__setSort('duration');
  await sleep(700);
  await setMode({ findScenes: 'fail-page-2' });
  await clearLog();
  await toBottom();
  await sleep(1600);
  const failed = await log();
  const p2s = failed.filter(r => r.page === 2);
  check('G8 the refused page was asked for exactly once', p2s.length === 1,
    `${p2s.length} page-2 request(s): ${pagesOf(failed)}; rows=${rowCount()}; `
    + `scroll=${scrollRoot()?.scrollTop}/${scrollRoot()?.scrollHeight}`);
  check('G8 …and the error is shown beside the rows',
    document.body.textContent.includes('VERIFY page 2 refused'),
    document.body.textContent.includes('VERIFY page 2 refused') ? '' : 'no error line');
  await setMode({ findScenes: 'ok' });
}

// ── The carousel / coverflow: focus-proximity paging ───────
// One driver for both: they page identically, and the difference between
// them (coverflow also tracks whether focus is inside the rail at all) is
// presentation.
async function runFocusWalk() {
  const t = V.t;
  await sleep(600);
  check(`${t}1 page 1 requested`, (await log()).length === 1, pagesOf(await log()).join(', '));
  check(`${t}1 the hero shows the first row`,
    document.body.textContent.includes('VERIFY scene 1'));

  // Walk the focus one card at a time toward the end. Stepping (rather than
  // jumping) is required: only cards within 4 of the focused index are
  // mounted, so the next card has to exist before it can be focused. The
  // trigger fires when the focused index comes within LOAD_MORE_THRESHOLD
  // (8) of the 40 loaded rows.
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
  // The grid gets this for free — it unmounts its sentinel once the last
  // short page lands, so there is nothing left to intersect. These views
  // have no sentinel: the trigger re-runs on every focus change and can
  // only be refused by the stop condition itself. That is why this check
  // lives here and not on the grid (and why it stayed green when the stop
  // was deleted and only the grid was tested).
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

  // ── C6  a refused page is reported, not retried ─────────
  // This is the strip's version of the grid's G8, and it is the one that
  // bites: the trigger here is not an observer that has to notice a change,
  // it is an effect that runs on every focus move and calls `loadMore`
  // whenever the cursor is near the end. Without a failure budget, one
  // refused page became one request per focus step, with nothing on screen
  // to say why. A fresh sort ensures page 2 is not in listService's cache.
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
  await sleep(900);
  const failedC = await log();
  const refused = failedC.filter(r => r.page === 2);
  check(`${t}6 the refused page was asked for once, not once per focus step`,
    refused.length === 1, `${refused.length} page-2 request(s): ${pagesOf(failedC)}`);
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
  // Before the render, so the first fetch already sees the fake endpoint —
  // `runQuery` reads the settings store per request, but the request goes out
  // from the mount effect, which React may flush before the next line.
  setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

  // Also before the render, and awaited. A view whose fixture is selected by
  // server mode would otherwise race its own first request: the fetch leaves
  // from the mount effect, and a `/mode` still in flight would land after it,
  // so the driver would assert against the default reply while believing it
  // had asked for the other one.
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
