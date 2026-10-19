/**
 * Headless driver for Home as a showroom (0.15.0's P9, reshaped in 0.18.0).
 *
 * Mounts the whole `App`, like rail-entry and sections-entry, because almost
 * every claim here is about two things at once: a shelf and the request it
 * sent, a See-all tile and the tab it opens, a tab's Back and the shelf it
 * returns to. No one component can be asked any of it alone.
 *
 * ## What is worth asserting, and what is not
 *
 * The shelves are deliberately plain: five fixed page-1 fetches and a slice.
 * Rendering a card is already covered everywhere else, so this file does not
 * re-assert that a card draws. It covers what is new in 0.18.0 and 0.18.4:
 *
 *   H1–H4  the showroom is five *fixed* shelves: Stash's order — Recently
 *          Released Scenes, Recently Added Studios, Recently Added Performers,
 *          Recently Released Galleries — with the user's own in-progress
 *          queue, Continue Watching, added in 0.18.4 directly below Recently
 *          Released Scenes. Five cards plus a See-all
 *          tile, no hidden horizontal scrolling. The tile is the strip's last
 *          element, because that is what makes Right past the fifth card land
 *          on it.
 *
 *   H2b    the geometry the TV asked for: bigger cards and three shelves in
 *          the first screen. Measured from real rects at 1920x1080 rather than
 *          re-derived from the stylesheet, so a font metric or a row margin
 *          that pushes the third shelf under the fold is a failure here.
 *
 *   H4b–e  each shelf sends *its own* query. This is the one thing a table of
 *          row definitions can get wrong one row at a time without anything
 *          failing to render — a studios shelf sorted by `scenes_count` would
 *          look perfectly healthy. Read from `/requests`, the fake's record of
 *          the GraphQL variables it was sent. H4b2/H4g are the same claim for
 *          Continue Watching, where a forgotten filter is a *plausible* five
 *          cards rather than an empty row: the fake honours `resume_time > 0`
 *          with a distinctive subset so the DOM can show the difference too.
 *
 *   H7–H14 the See-all hand-off. A tile is not a tab switch on its own: it has
 *          to arrive with the shelf's sort, order and filter, and that sort is
 *          *not* the destination tab's default for three of the five rows. The
 *          arrival rule (0.18.0) adopts each tab's default sort, so the tile
 *          carries `sortForTab` to mark its sort as deliberate. Continue
 *          Watching (Last Played vs Date Added, plus a filter), Studios (Date
 *          Added vs Name) and Galleries (Date vs Date Added) are the checks
 *          with teeth because their two values differ. Scenes and Performers
 *          ask for the same sort their tab defaults to, so the wire and the
 *          destination are all those two can assert.
 *
 *   H18    the hand-off marker is consumed. H18b carries the claim with teeth
 *          — an ordinary arrival at Studios must read Name, not the staged
 *          Date Added — while H18 asserts the Scenes filter is dropped.
 *
 *   H15–H17 pressing a Home card. A performer opens the detail page and Back
 *          returns Home to the same card (a dedicated `performerOrigin`, not
 *          `filterOrigin`); a studio and a gallery still route through the
 *          filter machinery and Back drops it.
 *
 *   H23    the resume question survives a stale shelf. The showroom is not
 *          refetched after playback, so the card still says 0 while Stash has
 *          a saved position; the detail page's uncached fetch is the fresh
 *          answer, and Play must carry it into the player's queue or the
 *          scene resumes silently.
 *
 * What this cannot tell you: whether five shelves read as a showroom, whether
 * TV overscan clips the fourth shelf, and anything about how the cards look on
 * the actual panel. That is the TV pass.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry, getCurrentFocusId } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;

// Written out rather than imported from ShowroomPage. The point of the check
// is that the rendered page agrees with the intent, and importing the table
// the page renders would make the two agree by construction. Five is the
// contract the CSS grid (six columns) and the "See all" tile are built on.
const SHELF = 5;
const SHELVES = [
  {
    key: 'recent-scenes', heading: 'Recently Added Scenes',
    prefix: 'showroom-recent-scenes-video', tile: 'showroom-seeall-recent-scenes',
  },
  {
    key: 'continue-watching', heading: 'Continue Watching',
    prefix: 'showroom-continue-video', tile: 'showroom-seeall-continue',
    // Card ids carry the *scene id*, and the fake answers `resume_time > 0`
    // with scenes 41–45. The other shelves' fixtures are 1..5, which is why
    // their first card is `<prefix>-1`; writing this one out keeps the check
    // about the prefix rather than about a coincidence of the fixture.
    firstId: 'showroom-continue-video-41',
  },
  {
    key: 'recent-studios', heading: 'Recently Added Studios',
    prefix: 'studio', tile: 'showroom-seeall-recent-studios',
  },
  {
    key: 'recent-performers', heading: 'Recently Added Performers',
    prefix: 'performer', tile: 'showroom-seeall-recent-performers',
  },
  {
    key: 'recent-galleries', heading: 'Recently Released Galleries',
    prefix: 'gallery', tile: 'showroom-seeall-recent-galleries',
  },
];

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

// ── Driving the remote ──────────────────────────────────────
// Same idiom as rail-entry: dispatched on the focused element with `bubbles`,
// which reaches useKeyHandler's window listener and useFocusable's element
// listener alike. 150ms between presses clears MIN_REPEAT_MS.
async function press(key) {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await sleep(150);
}

async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(200);
}

async function pressBack() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', {
    keyCode: 10009, key: 'Escape', bubbles: true, cancelable: true,
  }));
  await sleep(150);
}

const playerOpen = () => !!document.querySelector('[role="dialog"][aria-label^="Now playing"]');

/**
 * Close the player, in the presses the remote now needs.
 *
 * Playback shows the controls, and Back hides the bar before it closes the
 * player (see keyRouting.js). The 0.4 s between the presses lets the fade
 * finish and the key listener pick up the new state; the negative wait is
 * retried once with a second Back, so a bar that had already auto-hidden does
 * not turn this into an extra press on the screen below.
 */
async function closePlayer() {
  await pressBack();
  if (!(await waitFor(() => !playerOpen(), 400))) await pressBack();
  await waitFor(() => !playerOpen(), 3000);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};
const focusedId = () => getCurrentFocusId();

/** Open the Sort dropdown, choose a value, close it again — the three presses
 *  a user makes. Returns false if the menu never offered the value. */
async function chooseSort(value) {
  if (!focus('ctrl-sort')) return false;
  await sleep(150);
  await tapEnter();
  const offered = await waitFor(() => registry.has(`ctrl-sort-opt-${value}`), 2000);
  if (!offered) {
    await press('Escape');
    return false;
  }
  focus(`ctrl-sort-opt-${value}`);
  await sleep(80);
  await tapEnter();
  await sleep(300);
  return true;
}

const getJSON = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();
const clearLogs = async () => fetch(`http://127.0.0.1:${PORT}/clear`, { method: 'POST' });
/** Patch the fake server's behaviour. */
const setMode = async (patch) => fetch(`http://127.0.0.1:${PORT}/mode`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
});

/** "No criteria" on the wire is `{}`, not null: every service sends the
 *  filter variable as `translateFilter(...)`, which returns an empty GraphQL
 *  input for an absent filter. Asserting emptiness rather than null tests the
 *  intent — the request carried no criterion — without pinning the encoding. */
const unfiltered = (filter) => !filter || Object.keys(filter).length === 0;

const railActive = () =>
  [...(document.querySelector('nav[aria-label="Main navigation"]')?.querySelectorAll('button') ?? [])]
    .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || '(none)';

const sortText = () => registry.get('ctrl-sort')?.el.textContent?.trim() ?? '(none)';
const filterText = () => registry.get('ctrl-filter')?.el.textContent?.trim() ?? '(none)';
const descPressed = () => registry.get('ctrl-desc')?.el.getAttribute('aria-pressed');

/** Registry ids of a prefix whose element is still in the document. The
 *  registry outlives an unmounted card, and only a connected element is one
 *  the user can see. */
const liveIds = (prefix) => [...registry.entries()]
  .filter(([id, entry]) => id.startsWith(`${prefix}-`) && document.contains(entry.el))
  .map(([id]) => id);

/** The registry id behind an element. Used to assert that a vertical slot in a
 *  shelf draws the card family its row declares, rather than just some card. */
function idOfEl(el) {
  if (!el) return null;
  for (const [id, entry] of registry.entries()) {
    if (entry.el === el) return id;
  }
  return null;
}

const shelfEl = (key) => document.querySelector(`[data-showroom-row="${key}"]`);
const stripOf = (key) => shelfEl(key)?.lastElementChild;

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
  // The five shelves arrive over the wire. The gate is deliberately DOM-shaped
  // rather than keyed on a focus id: the per-row id prefix is one of the
  // things under test, so a gate that waited for a card id would report a
  // broken prefix as "Home never loaded" and the checks that name it would
  // never run. Five sections is enough: they are only rendered after all five
  // fetches resolve, so their presence means the shelves are final.
  const shelfReady = () => document.querySelectorAll('[data-showroom-row]').length === 5;
  const loaded = await waitFor(shelfReady, 8000);
  await sleep(400);
  if (!loaded) {
    check('H0 Home loaded its shelves', false,
      `shelves ${document.querySelectorAll('[data-showroom-row]').length}/5; focus ${focusedId()}; `
      + `rail ${railActive()}; errors: ${errorTail()}`);
    return;
  }

  // ── H0  the resting place ───────────────────────────────
  // Recently Added Scenes is the top shelf — Stash's own lead shelf, with
  // Continue Watching directly under it as of 0.18.4 — so its first card
  // autofocuses; every other shelf passes autoFocus false so five cards do
  // not race for it. The performer shelf is the one that could silently win:
  // PerformerCard defaulted to `index === 0` before 0.18.0, so it is named
  // explicitly in the failure detail.
  const atRest = focusedId();
  check('H0 Home rests on the first Recently Added card, and only one shelf claims focus',
    atRest === 'showroom-recent-scenes-video-1',
    `focus is ${atRest}; continue=${atRest === 'showroom-continue-video-41'} `
    + `studios=${atRest === 'studio-1'} performers=${atRest === 'performer-1'} `
    + `galleries=${atRest === 'gallery-1'}`);

  // ── H1  five shelves, in order ──────────────────────────
  const sections = [...document.querySelectorAll('[data-showroom-row]')];
  const gotKeys = sections.map(s => s.getAttribute('data-showroom-row'));
  const gotHeadings = sections.map(s => s.querySelector('h2')?.textContent?.trim() ?? '');
  check('H1 Home renders five shelves in order: scenes, continue, studios, performers, galleries',
    JSON.stringify(gotKeys) === JSON.stringify(SHELVES.map(s => s.key)),
    `rows: ${gotKeys.join(' · ') || '(none)'}`);
  check('H1 each shelf is headed with its name',
    JSON.stringify(gotHeadings) === JSON.stringify(SHELVES.map(s => s.heading)),
    gotHeadings.join(' · ') || '(no headings)');

  // ── H2  Home has no controls bar ────────────────────────
  const ctrlIds = [...registry.keys()].filter(k => k.startsWith('ctrl-'));
  check('H2 Home renders no controls bar at all',
    ctrlIds.length === 0
      && !document.querySelector('[role="toolbar"][aria-label="Controls"]'),
    ctrlIds.length ? `registered: ${ctrlIds.join(', ')}` : 'no ctrl- ids, no toolbar');

  // ── H2b  the geometry the TV asked for ──────────────────
  // Bigger cards and three shelves in the first screen. Read from rects, not
  // from arithmetic: the stylesheet's six 1fr tracks are only half the claim,
  // and a font metric or an extra row margin is exactly how "three rows fit"
  // silently stops being true. The second card is measured because the first
  // one is focused and scaled.
  {
    const page = shelfEl('recent-scenes')?.parentElement;
    const strip = stripOf('recent-scenes');
    const tracks = getComputedStyle(strip).gridTemplateColumns.trim();
    const trackCount = tracks.startsWith('repeat(')
      ? parseInt(tracks.slice(7), 10)
      : tracks.split(/\s+/).filter(Boolean).length;
    const width = strip?.children[1]?.getBoundingClientRect().width ?? 0;
    const vh = window.innerHeight;
    const r = (key) => shelfEl(key)?.getBoundingClientRect();

    const rects = SHELVES.map(s => {
      const rect = r(s.key);
      return `${s.key} ${rect ? `${Math.round(rect.top)}–${Math.round(rect.bottom)}` : '(none)'}`;
    }).join(' · ');

    check('H2b the strip has six tracks (five cards plus See all)',
      trackCount === SHELF + 1, `${trackCount} tracks — ${tracks}`);
    check('H2b cards are bigger than the old six-across layout',
      width >= 245 && width <= 275, `second card is ${width.toFixed(1)}px wide (was ~218)`);

    // One card footprint on all four shelves. This is the 0.18.2 fix: the
    // performer row's 3:4 portrait cards used to be 347px tall against 211 for
    // scenes and 151 for studios/galleries. Read the first strip cell, which
    // is never the focus-scaled one, and round to whole pixels because the
    // tracks are fractional under a 1fr grid.
    const cardH = Object.fromEntries(SHELVES.map(s => [
      s.key,
      Math.round(stripOf(s.key)?.children[0]?.getBoundingClientRect().height ?? 0),
    ]));
    const heights = Object.values(cardH);
    check('H2b all five shelves draw the same card height',
      heights.every(h => h > 0 && Math.abs(h - heights[0]) <= 1),
      Object.entries(cardH).map(([k, h]) => `${k} ${h}px`).join(' · '));
    check('H2b that shared card height is the sizing contract (~240px)',
      heights[0] >= 230 && heights[0] <= 250,
      `card height ${heights[0]}px`);
    check('H2b the See-all tile is the same height as the cards',
      SHELVES.every(s => Math.abs(
        (stripOf(s.key)?.lastElementChild?.getBoundingClientRect().height ?? 0) - cardH[s.key]) <= 1),
      SHELVES.map(s => `${s.key} tile ${
        Math.round(stripOf(s.key)?.lastElementChild?.getBoundingClientRect().height ?? 0)}px`
      ).join(' · '));

    // Equal wrappers are not enough: a card that kept its aspect ratio would
    // still sit in a 240px box, either leaving a blank strip under a scene
    // info bar or clipping the performer overlay out of view. The two scene
    // shelves have a bar below the art; the other three overlay their text, so
    // their single child must be the full card face.
    const artGap = Object.fromEntries(SHELVES.map(s => {
      const card = stripOf(s.key)?.children[0]?.firstElementChild;
      if (!card) return [s.key, 'no card'];
      const cr = card.getBoundingClientRect();
      // The two scene shelves end in the info bar, so their fill is measured
      // against that; the overlay rows' whole face is their first child. Read
      // the *kind*, not one key, or the continue shelf silently falls into the
      // overlay branch and reports the info bar's height as a gap.
      if (['continue-watching', 'recent-scenes'].includes(s.key)) {
        return [s.key, Math.round(cr.bottom - card.lastElementChild.getBoundingClientRect().bottom)];
      }
      return [s.key, Math.round(cr.height - card.firstElementChild.getBoundingClientRect().height)];
    }));
    check('H2b each card’s art fills its fixed height',
      Object.values(artGap).every(g => typeof g === 'number' && Math.abs(g) <= 3),
      Object.entries(artGap).map(([k, g]) => `${k} gap ${g}px`).join(' · '));
    const firstThree = ['recent-scenes', 'continue-watching', 'recent-studios'];
    check('H2b the first three shelves are fully on the first screen',
      page?.scrollTop === 0
        && firstThree.every(k => r(k) && r(k).bottom <= vh + 1),
      `scrollTop=${page?.scrollTop}; viewport ${vh}px; ${rects}`);
    check('H2b the fourth shelf begins above the fold',
      !!r('recent-performers')
        && r('recent-performers').top < vh
        && (stripOf('recent-performers')?.getBoundingClientRect().top ?? vh) < vh,
      `performers section top ${Math.round(r('recent-performers')?.top ?? -1)}px, `
      + `strip top ${Math.round(stripOf('recent-performers')?.getBoundingClientRect().top ?? -1)}px; ${rects}`);
  }

  // ── H4  five cards and a See-all tile per shelf ─────────
  for (const shelf of SHELVES) {
    const ids = liveIds(shelf.prefix);
    const strip = stripOf(shelf.key);
    const tile = strip?.lastElementChild;
    check(`H4 ${shelf.key}: five cards, with See all as the last element`,
      ids.length === SHELF
        && !!tile
        && tile.hasAttribute('data-see-all')
        && tile.getAttribute('data-see-all') === shelf.key
        && registry.has(shelf.tile),
      `${ids.length} card id(s); strip's last child is ${tile?.tagName}`
      + `${tile?.hasAttribute('data-see-all') ? ` [see all ${tile.getAttribute('data-see-all')}]` : ''}`
      + `; tile registered=${registry.has(shelf.tile)}`);
  }

  // Each shelf draws its own card family. A gallery row rendered with the
  // studio descriptor would draw perfectly well and register `studio-*` ids,
  // which is both the wrong detail destination and a registry collision with
  // the studios shelf above it.
  for (const shelf of SHELVES) {
    // The first slot is a `.cell` wrapper (it owns the shelf's fixed height);
    // the card whose focus id proves the card family is its first child.
    const first = stripOf(shelf.key)?.firstElementChild?.firstElementChild;
    const expected = shelf.firstId || `${shelf.prefix}-1`;
    check(`H4f ${shelf.key}: the first slot holds a ${shelf.prefix} card`,
      idOfEl(first) === expected, `first slot is ${idOfEl(first)}, wanted ${expected}`);
  }

  // ── H4b–e  each shelf's own request ─────────────────────
  // `/requests` is the fake's record of the GraphQL variables it received, so
  // this is the shelf table verified at the wire rather than at the table. The
  // limit is what tells a shelf apart from the tab: a shelf asks for five.
  const reqs = await getJSON('/requests');
  const sceneShelves = reqs.filter(r => r.scene_filter !== undefined && r.per_page === SHELF);
  const studioShelves = reqs.filter(r => r.studio_filter !== undefined && r.per_page === SHELF);
  const performerShelves = reqs.filter(r => r.performer_filter !== undefined && r.per_page === SHELF);
  const galleryShelves = reqs.filter(r => r.gallery_filter !== undefined && r.per_page === SHELF);

  // Newest-added scenes: `date` is the release date, so with it an old film
  // added today would not be on the "Recently Added" shelf at all. `created_at`
  // is the library's own arrival order, and the Scenes tab's default sort.
  const scenesReq = sceneShelves.find(r => r.sort === 'created_at');
  check('H4b the Scenes shelf asks for created_at, descending, unfiltered',
    !!scenesReq && scenesReq.direction === 'DESC' && unfiltered(scenesReq.scene_filter),
    scenesReq ? JSON.stringify(scenesReq)
      : `no per_page=${SHELF} FindScenes sorted by created_at`);

  // Continue Watching is the one shelf that is also a filter. Both halves are
  // asserted: a shelf that forgot `resume_time` would otherwise be five
  // perfectly plausible newest scenes sorted by an engagement field.
  const continueReq = sceneShelves.find(r => r.sort === 'last_played_at');
  const continueCriterion = continueReq?.scene_filter?.resume_time || {};
  const continueValue = typeof continueCriterion.value === 'object'
    ? continueCriterion.value?.value
    : continueCriterion.value;
  check('H4b2 the Continue Watching shelf asks for last_played_at, descending, resume_time > 0',
    !!continueReq && continueReq.direction === 'DESC'
      && continueCriterion.modifier === 'GREATER_THAN' && continueValue === 0,
    continueReq ? JSON.stringify(continueReq) : `no per_page=${SHELF} FindScenes sorted by last_played_at`);

  // …and the DOM agrees. The fake answers `resume_time > 0` with scenes 41–45
  // and everything else with 1..N, so this is the difference between "the
  // shelf applied its criterion" and "the shelf asked for the right sort".
  // The aria-label carries the title alone (`VERIFY scene 41`); textContent
  // runs the resolution and year into it, so "…scene 41" is not distinguishable
  // from "…scene 412" there.
  const cardLabel = (el) => el?.getAttribute('aria-label') || '';
  const continueFirstCard = stripOf('continue-watching')?.children[0]?.firstElementChild;
  const recentFirstCard = stripOf('recent-scenes')?.children[0]?.firstElementChild;
  check('H4g the Continue shelf is drawn from the in-progress set, not the newest scenes',
    cardLabel(continueFirstCard).startsWith('VERIFY scene 41')
      && cardLabel(recentFirstCard).startsWith('VERIFY scene 1,'),
    `continue first card "${cardLabel(continueFirstCard) || '(none)'}"; `
    + `recent first card "${cardLabel(recentFirstCard) || '(none)'}"`);

  const studiosReq = studioShelves.find(r => r.sort === 'created_at');
  check('H4c the Studios shelf asks for created_at, descending, unfiltered',
    !!studiosReq && studiosReq.direction === 'DESC' && unfiltered(studiosReq.studio_filter),
    studiosReq ? JSON.stringify(studiosReq) : `no per_page=${SHELF} FindStudios sorted by created_at`);

  const performersReq = performerShelves.find(r => r.sort === 'created_at');
  check('H4d the Performers shelf asks for created_at, descending, unfiltered',
    !!performersReq && performersReq.direction === 'DESC' && unfiltered(performersReq.performer_filter),
    performersReq ? JSON.stringify(performersReq) : `no per_page=${SHELF} FindPerformers sorted by created_at`);

  const galleriesReq = galleryShelves.find(r => r.sort === 'date');
  check('H4e the Galleries shelf asks for date, descending, unfiltered',
    !!galleriesReq && galleriesReq.direction === 'DESC' && unfiltered(galleriesReq.gallery_filter),
    galleriesReq ? JSON.stringify(galleriesReq) : `no per_page=${SHELF} FindGalleries sorted by date`);

  // ── H5  Down/Up walk the shelves ────────────────────────
  // Same column, one shelf apart: the first card of each shelf is directly
  // under the first card of the one above.
  const walk = [];
  if (focus('showroom-recent-scenes-video-1')) {
    walk.push(focusedId());
    await press('ArrowDown');
    walk.push(focusedId());   // continue
    await press('ArrowDown');
    walk.push(focusedId());   // studios
    await press('ArrowDown');
    walk.push(focusedId());   // performers
    await press('ArrowDown');
    walk.push(focusedId());   // galleries
    await press('ArrowUp');
    walk.push(focusedId());
    await press('ArrowUp');
    walk.push(focusedId());
    await press('ArrowUp');
    walk.push(focusedId());
    await press('ArrowUp');
    walk.push(focusedId());
  }
  check('H5 Down walks scenes → continue → studios → performers → galleries, Up walks back',
    walk.join('>') === [
      'showroom-recent-scenes-video-1',
      'showroom-continue-video-41',
      'studio-1',
      'performer-1',
      'gallery-1',
      'performer-1',
      'studio-1',
      'showroom-continue-video-41',
      'showroom-recent-scenes-video-1',
    ].join('>'),
    walk.join(' > ') || 'the first Recently Added card is not focusable');

  // Up must restore the top of Home, not merely the first card. The page
  // scrolled to reach the gallery shelf; `block:'nearest'` on the card would
  // align the *card's* top edge with the scrollport, leaving the page's top
  // padding and the top shelf's heading above the fold — and, with the card's
  // focus scale and -4px lift, clipping its top by a few pixels. Reported from
  // the TV 2026-10-17: "scrolling to bottom and the back again it doesn't
  // return fully to top position (recently released scenes text doesnt appear
  // at all, icons are cut off by few pixels too)".
  {
    const page = shelfEl('recent-scenes')?.parentElement;
    const heading = shelfEl('recent-scenes')?.querySelector('h2');
    const hr = heading?.getBoundingClientRect();
    const card = registry.get('showroom-recent-scenes-video-1')?.el;
    const cr = card?.getBoundingClientRect();
    check('H5 Up back to the top shelf restores the top of Home',
      page?.scrollTop === 0 && !!hr && hr.top >= 0 && !!cr && cr.top >= 0,
      `scrollTop=${page?.scrollTop}; heading top=${Math.round(hr?.top ?? -1)}; `
      + `card top=${Math.round(cr?.top ?? -1)}`);
  }

  // ── H6  Right past the fifth card reaches See all ───────
  let afterRight = '(not run)';
  if (focus('showroom-continue-video-45')) {
    await sleep(80);
    await press('ArrowRight');
    afterRight = focusedId();
  }
  check('H6 Right from the fifth Continue Watching card lands on its See-all tile',
    afterRight === 'showroom-seeall-continue', `Right → ${afterRight}`);

  // ── H11  Up from the top shelf reaches the rail ─────────
  let afterUp = '(not run)';
  if (focus('showroom-recent-scenes-video-1')) {
    await sleep(80);
    await press('ArrowUp');
    afterUp = focusedId();
  }
  check('H11 Up from the top shelf reaches the rail at Home',
    afterUp === 'nav-home', `Up → ${afterUp}`);

  // ── H3  Scenes still has everything the old Home had ────
  focus('nav-scenes');
  await sleep(120);
  await tapEnter();
  const scenesUp = await waitFor(() => registry.has('video-1'), 5000);
  await sleep(250);
  check('H3 Scenes switches to its tab and renders the scene grid',
    scenesUp && railActive() === 'Scenes' && !!document.querySelector('[role="grid"]')
      && liveIds('video').length > 0,
    `rail=${railActive()} grid=${!!document.querySelector('[role="grid"]')} `
    + `cards=${liveIds('video').length}`);
  check('H3 Scenes carries the controls the showroom does not',
    !!registry.get('ctrl-mode') && !!registry.get('ctrl-sort')
      && !!registry.get('ctrl-filter') && !!registry.get('ctrl-asc')
      && !!registry.get('ctrl-desc'),
    `mode=${!!registry.get('ctrl-mode')} sort=${!!registry.get('ctrl-sort')} `
    + `filter=${!!registry.get('ctrl-filter')} order=${!!registry.get('ctrl-desc')}`);

  // ── Back to Home, on which every See-all check depends ──
  async function backHome() {
    focus('nav-home');
    await sleep(120);
    await tapEnter();
    return waitFor(() => registry.has('showroom-seeall-recent-scenes'), 5000);
  }

  /** Press a See-all tile and wait for the destination tab's controls. */
  async function pressTile(tileId, tab) {
    focus(tileId);
    await sleep(120);
    await tapEnter();
    return waitFor(() => railActive() === tab && !!registry.has('ctrl-sort'), 4000);
  }

  const backToHome = async (tileId) => {
    await pressBack();
    const home = await waitFor(() => railActive() === 'Home', 4000);
    const backFocus = await waitFor(() => focusedId() === tileId, 4000);
    check(`Back from ${tileId} returns Home with focus on the tile, no exit prompt`,
      home && backFocus && !document.querySelector('[role="dialog"]'),
      `rail=${railActive()} focus=${focusedId()} `
      + `dialog=${document.querySelector('[role="dialog"]') ? 'open' : 'none'}`);
  };

  await backHome();
  await sleep(200);

  // ── H7  Recently Added Scenes See all ───────────────────
  // The shelf now asks for the newest *added* scenes (`created_at`), which is
  // also the Scenes tab's default. The listing may therefore already be in the
  // page cache — before 0.21.2 the shelf's `date` was a different key, so this
  // press always fetched. Accept either: no new 40-row request (the card set
  // is the tab-default one by construction) or a new one carrying the same
  // sort, descending and unfiltered. A press that fetched the *release-date*
  // page would show up in the second case with sort `date`, and fail.
  await clearLogs();
  const reqsBefore = (await getJSON('/requests')).length;
  const scenesArrived = await pressTile('showroom-seeall-recent-scenes', 'Scenes');
  const scenesFocused = await waitFor(() => String(focusedId() || '').startsWith('video-'), 3000);
  await sleep(300);
  const scenesReqAfter = (await getJSON('/requests')).slice(reqsBefore)
    .filter(r => r.scene_filter !== undefined && r.per_page === 40)
    .slice(-1)[0];
  check('H7 Scenes See all opens Scenes', scenesArrived, `rail=${railActive()}`);
  check('H7 the listing is created_at/desc and unfiltered, from the cache or the wire',
    !scenesReqAfter
      || (scenesReqAfter.sort === 'created_at' && scenesReqAfter.direction === 'DESC'
          && unfiltered(scenesReqAfter.scene_filter)),
    scenesReqAfter ? JSON.stringify(scenesReqAfter) : 'served from the tab-default cache');
  check('H7 the sort control reads Date Added',
    sortText() === 'Date Added', `sort reads "${sortText()}"`);
  check('H7 order is descending and the filter is All',
    descPressed() === 'true' && filterText() === 'All',
    `desc=${descPressed()} filter="${filterText()}"`);
  check('H7 focus lands on a scene card', scenesFocused, `focus is ${focusedId()}`);

  // ── H10a  Back returns to the tile that was pressed ─────
  await backToHome('showroom-seeall-recent-scenes');

  // ── H19  Continue Watching See all (0.18.4) ─────────────
  // The only filtered shelf hand-off. Four claims, and each fails on its own
  // kind of mistake: the wire proves the criterion and sort travelled, the
  // control reads the shelf's sort rather than Scenes' default, the dropdown
  // names the shelf rather than "Custom filter", and the rendered count proves
  // the *listing* applied the filter rather than merely carrying it in state
  // (the fake answers it with exactly five scenes).
  await clearLogs();
  const continueArrived = await pressTile('showroom-seeall-continue', 'Scenes');
  const continueFocused = await waitFor(() => String(focusedId() || '').startsWith('video-'), 3000);
  await sleep(300);
  const continueListingReq = (await getJSON('/requests'))
    .filter(r => r.scene_filter !== undefined)
    .slice(-1)[0];
  const listingCriterion = continueListingReq?.scene_filter?.resume_time || {};
  const listingValue = typeof listingCriterion.value === 'object'
    ? listingCriterion.value?.value
    : listingCriterion.value;
  check('H19 Continue Watching See all opens Scenes', continueArrived, `rail=${railActive()}`);
  check('H19 with last_played_at/desc and resume_time > 0 on the wire',
    !!continueListingReq && continueListingReq.per_page === 40
      && continueListingReq.sort === 'last_played_at'
      && continueListingReq.direction === 'DESC'
      && listingCriterion.modifier === 'GREATER_THAN' && listingValue === 0,
    continueListingReq ? JSON.stringify(continueListingReq) : 'no FindScenes request after the press');
  check('H19 the sort control reads Last Played, not the tab default',
    sortText() === 'Last Played', `sort reads "${sortText()}"`);
  check('H19 the filter dropdown names the shelf',
    filterText() === 'Continue Watching', `filter reads "${filterText()}"`);
  check('H19 the listing is the filtered set, not the whole library',
    liveIds('video').length === 5, `${liveIds('video').length} scene card(s)`);
  check('H19 focus lands on a scene card', continueFocused, `focus is ${focusedId()}`);

  // ── H20  Back drops the shelf's filter and restores the tile ─
  await backToHome('showroom-seeall-continue');

  // ── H8  the hand-off overrides a previously chosen sort ─
  // On Scenes, choose Title — a valid, non-default sort — then return Home and
  // press the tile again. The shelf's `created_at` is now the tab default too,
  // so the assertion is only that Title does not survive; the discriminating
  // marker check lives in H18b, where the staged sort differs from the tab
  // default.
  focus('nav-scenes');
  await sleep(120);
  await tapEnter();
  await waitFor(() => railActive() === 'Scenes' && registry.has('ctrl-sort'), 4000);
  await sleep(300);
  const choseTitle = await chooseSort('title');
  await sleep(250);
  const titleChosen = sortText() === 'Title';
  await backHome();
  await sleep(300);
  const overrideArrived = await pressTile('showroom-seeall-recent-scenes', 'Scenes');
  check('H8 See all leaves the previously chosen sort, back on Date Added',
    choseTitle && titleChosen && overrideArrived && sortText() === 'Date Added',
    `chose Title=${choseTitle && titleChosen}; after the tile sort reads "${sortText()}"`);

  // ── H10b ────────────────────────────────────────────────
  await backToHome('showroom-seeall-recent-scenes');

  // ── H18  the hand-off marker and the filter do not outlive their arrival ─
  // Opening Scenes from the rail — an ordinary arrival, with no tile involved
  // — must show the tab's default. The shelf's sort now equals that default,
  // so the sort half proves only that Title did not survive; H18b is where a
  // staged sort that *differs* from the default is the assertion. The filter
  // half still has teeth for H20's Continue Watching criterion: Back out of
  // the filtered listing and arrive here normally, and Scenes must be All.
  focus('nav-scenes');
  await sleep(120);
  await tapEnter();
  await waitFor(() => registry.has('ctrl-sort'), 4000);
  await sleep(300);
  check('H18 an ordinary arrival at Scenes shows the tab default and drops the shelf filter',
    sortText() === 'Date Added' && filterText() === 'All',
    `sort reads "${sortText()}"; filter reads "${filterText()}"`);

  await backHome();
  await sleep(200);

  // ── H9  Recently Added Studios See all ──────────────────
  // The Studios tab defaults to Name; the shelf asks for Date Added, so the
  // control is discriminating here as well as the wire.
  await clearLogs();
  const studiosArrived = await pressTile('showroom-seeall-recent-studios', 'Studios');
  const studiosFocused = await waitFor(() => String(focusedId() || '').startsWith('studio-'), 3000);
  await sleep(300);
  const studiosReqAfter = (await getJSON('/requests'))
    .filter(r => r.studio_filter !== undefined)
    .slice(-1)[0];
  check('H9 Studios See all opens the Studios tab', studiosArrived, `rail=${railActive()}`);
  check('H9 with created_at/desc and no filter on the wire',
    !!studiosReqAfter && studiosReqAfter.per_page === 40
      && studiosReqAfter.sort === 'created_at'
      && studiosReqAfter.direction === 'DESC' && unfiltered(studiosReqAfter.studio_filter),
    studiosReqAfter ? JSON.stringify(studiosReqAfter) : 'no FindStudios request after the press');
  check('H9 the sort control reads Date Added, not the tab default Name',
    sortText() === 'Date Added', `sort reads "${sortText()}"`);
  check('H9 focus lands on a studio card', studiosFocused, `focus is ${focusedId()}`);

  // ── H10c ────────────────────────────────────────────────
  await backToHome('showroom-seeall-recent-studios');

  // ── H18b  the Studios hand-off marker does not outlive its arrival ─
  // The Studios shelf stages `created_at` against a tab default of Name, so a
  // leftover marker would keep Date Added. H9 just consumed the marker by
  // holding it through the arrival; coming in from the rail again must read
  // Name. This is the marker-consumption claim H18 lost when the Scenes shelf
  // moved onto the tab's own default sort.
  focus('nav-studios');
  await sleep(120);
  await tapEnter();
  await waitFor(() => railActive() === 'Studios' && registry.has('ctrl-sort'), 4000);
  await sleep(300);
  check('H18b an ordinary arrival at Studios shows Name, not the hand-off sort',
    sortText() === 'Name', `sort reads "${sortText()}"`);
  await backHome();
  await sleep(200);

  // ── H13  Recently Added Performers See all ──────────────
  // The shelf sort equals the tab default here, so the control cannot
  // distinguish marker from default; the destination, the wire and the focus
  // are the claims.
  await clearLogs();
  const performersArrived = await pressTile('showroom-seeall-recent-performers', 'Performers');
  const performersFocused = await waitFor(
    () => !!document.querySelector('[role="grid"]') && focusedId() === 'performer-1', 3000);
  await sleep(300);
  const performersReqAfter = (await getJSON('/requests'))
    .filter(r => r.performer_filter !== undefined)
    .slice(-1)[0];
  check('H13 Performers See all opens the Performers tab', performersArrived, `rail=${railActive()}`);
  check('H13 with created_at/desc and no filter on the wire',
    !!performersReqAfter && performersReqAfter.per_page === 40
      && performersReqAfter.sort === 'created_at'
      && performersReqAfter.direction === 'DESC' && unfiltered(performersReqAfter.performer_filter),
    performersReqAfter ? JSON.stringify(performersReqAfter) : 'no FindPerformers request after the press');
  check('H13 focus lands on the Performers grid card', performersFocused, `focus is ${focusedId()}`);

  // ── H13b  Back precedence: detail → grid → Home ─────────
  // A detail opened from inside the See-all Performers listing must return to
  // that listing first. `performerOrigin` is deliberately separate from
  // `filterOrigin` for exactly this: reusing the latter would make the first
  // Back jump all the way Home.
  focus('performer-1');
  await sleep(100);
  await tapEnter();
  const detailUp = await waitFor(() => registry.has('detail-back'), 4000);
  await pressBack();
  const stillPerformers = await waitFor(
    () => railActive() === 'Performers' && focusedId() === 'performer-1', 4000);
  check('H13b Back from a detail opened in the Performers listing stays on Performers',
    detailUp && stillPerformers, `rail=${railActive()} focus=${focusedId()}`);

  // ── H10d  …and the next Back returns Home ───────────────
  await backToHome('showroom-seeall-recent-performers');

  // ── H14  Recently Released Galleries See all ────────────
  // Galleries default to Date Added; the shelf asks for Date. The control
  // text is compared exactly: a /Date/ regex would also match "Date Added".
  await clearLogs();
  const galleriesArrived = await pressTile('showroom-seeall-recent-galleries', 'Galleries');
  const galleriesFocused = await waitFor(() => focusedId() === 'gallery-1', 3000);
  await sleep(300);
  const galleriesReqAfter = (await getJSON('/requests'))
    .filter(r => r.gallery_filter !== undefined)
    .slice(-1)[0];
  check('H14 Galleries See all opens the Galleries tab', galleriesArrived, `rail=${railActive()}`);
  check('H14 with date/desc and no filter on the wire',
    !!galleriesReqAfter && galleriesReqAfter.per_page === 40
      && galleriesReqAfter.sort === 'date'
      && galleriesReqAfter.direction === 'DESC' && unfiltered(galleriesReqAfter.gallery_filter),
    galleriesReqAfter ? JSON.stringify(galleriesReqAfter) : 'no FindGalleries request after the press');
  check('H14 the sort control reads Date, not Date Added',
    sortText() === 'Date', `sort reads "${sortText()}"`);
  check('H14 focus lands on a gallery card', galleriesFocused, `focus is ${focusedId()}`);

  // ── H10e ────────────────────────────────────────────────
  await backToHome('showroom-seeall-recent-galleries');

  // ── H15  a performer opened from Home returns Home ──────
  // The detail page only renders under the Performers tab, so this crosses a
  // tab switch. `performerOrigin` names the Home card by id; the focus restore
  // goes through `focusByIdWhenReady` because Home remounts and refetches.
  await waitFor(() => registry.has('performer-3'), 4000);
  await clearLogs();
  focus('performer-3');
  await sleep(120);
  await tapEnter();
  const homeDetail = await waitFor(
    () => railActive() === 'Performers' && registry.has('detail-back'), 4000);
  // The profile fetch is one small query on top of the card. Assert it from the
  // production App path: the alias fixture is only reachable through it.
  const profileShown = await waitFor(
    () => document.body.textContent.includes('VERIFY profile alias one'), 4000);
  const detailCalls = await getJSON('/graphqlcalls');
  check('H15 the detail opened from Home fetched and rendered its profile fields',
    homeDetail && profileShown && detailCalls.includes('FindPerformerDetail'),
    `profile=${profileShown} calls=${detailCalls.join(', ')}`);
  await pressBack();
  const backToCard = await waitFor(
    () => railActive() === 'Home' && focusedId() === 'performer-3', 5000);
  check('H15 Back from a performer opened on Home returns Home to that card',
    homeDetail && backToCard && !document.querySelector('[role="dialog"]'),
    `detail=${homeDetail}; rail=${railActive()} focus=${focusedId()} `
    + `dialog=${document.querySelector('[role="dialog"]') ? 'open' : 'none'}`);

  // ── H16  a studio pressed on Home opens its scenes ──────
  await waitFor(() => registry.has('studio-2'), 4000);
  await clearLogs();
  focus('studio-2');
  await sleep(120);
  await tapEnter();
  await waitFor(() => railActive() === 'Scenes' && !!registry.has('ctrl-sort'), 4000);
  await sleep(300);
  const studioSceneReq = (await getJSON('/requests'))
    .filter(r => r.scene_filter !== undefined && r.per_page === 40)
    .slice(-1)[0];
  const studioValues = studioSceneReq?.scene_filter?.studios?.value || [];
  focus('ctrl-filter');
  const studioFilterText = filterText();
  await pressBack();
  const studioBack = await waitFor(
    () => railActive() === 'Home' && focusedId() === 'studio-2', 5000);
  check('H16 a Home studio opens Scenes filtered to it, and Back restores the shelf',
    railActive() === 'Home' && studioBack
      && studioValues.map(String).includes('2')
      && /VERIFY studio 2/.test(studioFilterText),
    `wire values=${JSON.stringify(studioValues)} dropdown="${studioFilterText}" `
    + `back=${studioBack} rail=${railActive()} focus=${focusedId()}`);

  // ── H17  a gallery pressed on Home opens its images ─────
  await waitFor(() => registry.has('gallery-4'), 4000);
  await clearLogs();
  focus('gallery-4');
  await sleep(120);
  await tapEnter();
  await waitFor(() => railActive() === 'Images' && !!registry.has('ctrl-sort'), 4000);
  await sleep(300);
  const galleryImageReq = (await getJSON('/requests'))
    .filter(r => r.image_filter !== undefined && r.per_page === 40)
    .slice(-1)[0];
  const galleryValues = galleryImageReq?.image_filter?.galleries?.value || [];
  focus('ctrl-filter');
  const galleryFilterText = filterText();
  await pressBack();
  const galleryBack = await waitFor(
    () => railActive() === 'Home' && focusedId() === 'gallery-4', 5000);
  check('H17 a Home gallery opens Images filtered to it, and Back restores the shelf',
    railActive() === 'Home' && galleryBack
      && galleryValues.map(String).includes('4')
      && /VERIFY gallery 4/.test(galleryFilterText),
    `wire values=${JSON.stringify(galleryValues)} dropdown="${galleryFilterText}" `
    + `back=${galleryBack} rail=${railActive()} focus=${focusedId()}`);

  // ── H21  clearing progress prunes the card in place ─────
  //
  // The end-to-end claim of the scene page's Clear progress action: Home is
  // still mounted underneath the overlay, so its five requests do not re-run.
  // The page reports the cleared id to App, App hands it to the showroom, and
  // the card goes. Then Back has to land somewhere — the card it would have
  // restored no longer exists, so the close handler falls back to the first
  // control in the page.
  await waitFor(() => registry.has('showroom-continue-video-41'), 4000);
  await clearLogs();
  focus('showroom-continue-video-41');
  await sleep(120);
  await tapEnter();
  const clearOffered = await waitFor(
    () => registry.has('scene-clear-progress') && !registry.get('scene-clear-progress').el.disabled,
    5000);
  focus('scene-clear-progress');
  await tapEnter();
  const cleared = await waitFor(
    () => /Progress cleared/.test(document.body.textContent), 3000);
  await pressBack();
  const cardGone = await waitFor(
    () => !registry.has('showroom-continue-video-41')
      && liveIds('showroom-continue-video').length === 4, 4000);
  const resets = await getJSON('/resetcalls');
  const reset = resets.at(-1);
  check('H21 Clear progress on a Continue Watching card removes that card in place',
    clearOffered && cleared && cardGone
      && !document.querySelector('[role="dialog"]'),
    `offered=${clearOffered} cleared=${cleared} gone=${cardGone} `
    + `cards=${liveIds('showroom-continue-video').length} `
    + `dialog=${document.querySelector('[role="dialog"]') ? 'open' : 'none'}`);
  check('H21 ...after asking Stash to reset the resume point and only the resume point',
    !!reset && reset.id === '41' && reset.reset_resume === true
      && reset.reset_duration === false,
    reset ? JSON.stringify(reset) : 'no SceneResetActivity request');
  check('H21 ...and focus falls back into the page rather than onto <body>',
    focusedId() === 'showroom-recent-scenes-video-1',
    `focus is ${focusedId()} (the pruned card's focus id was the restore target)`);

  // ── H22  clearing progress then playing raises no stale question ─
  //
  // The card is what the Play press builds the player's queue from, and it
  // still carries resume_time 60 when Clear progress runs. App patches that
  // card on the page's report. Without the patch the player asks "Resume from
  // 1:00?" about a position the user just explicitly discarded — on the very
  // next press, which is what makes it worse than a stale shelf: it is a
  // question with no correct answer offered.
  await waitFor(() => registry.has('showroom-continue-video-42'), 4000);
  focus('showroom-continue-video-42');
  await sleep(120);
  await tapEnter();
  const clear42 = await waitFor(
    () => registry.has('scene-clear-progress') && !registry.get('scene-clear-progress').el.disabled,
    5000);
  focus('scene-clear-progress');
  await tapEnter();
  const cleared42 = await waitFor(
    () => /Progress cleared/.test(document.body.textContent), 3000);
  focus('scene-play');
  await tapEnter();
  const playerUp = await waitFor(
    () => !!document.querySelector('[role="dialog"][aria-label^="Now playing"]'), 4000);
  await sleep(300);
  const stalePrompt = document.querySelector(
    '[role="dialog"][aria-label="Resume playback"]');
  check('H22 Clear progress then Play asks nothing about the discarded position',
    clear42 && cleared42 && playerUp && !stalePrompt,
    `offered=${clear42} cleared=${cleared42} player=${playerUp} prompt=${!!stalePrompt}`);
  const freshV = document.querySelector('video');
  const startsFresh = await waitFor(() => freshV && freshV.currentTime < 5, 3000);
  check('H22 ...and playback starts from the beginning',
    startsFresh, `currentTime=${freshV?.currentTime?.toFixed(1)}`);

  await closePlayer();
  // The scene-42 page is still open under the player. Close it so the next
  // check starts from the shelf, as the user does.
  await pressBack();
  await waitFor(() => !document.querySelector('[role="dialog"]'), 3000);

  // ── H23  a stale card still asks, because the detail fetch is fresh ─
  //
  // The user's own sequence: play a recent scene, pause, Back — the shelf is
  // not refetched, so its card still says resume_time 0 while Stash now has a
  // saved position. Play from that stale card used to seek silently. The
  // detail page's uncached FindSceneDetail is the one fresh answer the player
  // can be given, so Play has to carry it into the queue. Two modes are set
  // because the app makes two reads: the per-open fetch agrees with the saved
  // position (22), which is what makes the old failure a *silent* seek rather
  // than a visible inconsistency.
  await setMode({ detailResume: 22, resume: 22 });
  await waitFor(() => registry.has('showroom-recent-scenes-video-1'), 4000);
  const detailBefore = (await getJSON('/detailfetches')).length;
  focus('showroom-recent-scenes-video-1');
  await sleep(120);
  await tapEnter();
  await waitFor(() => registry.has('scene-play'), 4000);
  // `scene-play` is registered from the card-first paint. Wait for the fresh
  // fetch to land before pressing it, or Play forwards the stale 0 the card
  // itself carries — which is the failure this check exists to catch.
  for (const end = Date.now() + 4000; Date.now() < end; await sleep(50)) {
    if ((await getJSON('/detailfetches')).length > detailBefore) break;
  }
  await sleep(250);
  focus('scene-play');
  await tapEnter();
  const asksAgain = await waitFor(
    () => !!document.querySelector('[role="dialog"][aria-label="Resume playback"]'), 5000);
  check('H23 Play on a card whose shelf is stale asks about the fetched resume point',
    asksAgain,
    `prompt=${asksAgain} — the shelf card says 0, FindSceneDetail said 22`);
  // Answer "start from the beginning" and confirm the declined position was
  // not applied anyway — the two halves the prompt exists for.
  focus('resume-prompt-start');
  await tapEnter();
  await waitFor(() => !document.querySelector('[role="dialog"][aria-label="Resume playback"]'), 3000);
  const restarted = await waitFor(() => {
    const v = document.querySelector('video');
    return !!v && v.currentTime < 5;
  }, 4000);
  check('H23 ...and starting over begins at zero',
    restarted,
    `currentTime=${document.querySelector('video')?.currentTime?.toFixed(1)}`);
  await closePlayer();
  // The scene-1 detail page is open under the player; close it the way the
  // user does so the last check starts from Home.
  await pressBack();
  await waitFor(() => !document.querySelector('[role="dialog"]'), 3000);

  // The rail-row focus guard has its own check in rail-entry (R11), against a
  // listing that has actually ended. An earlier H24 here tried to prove it
  // from Home's bottom shelf, but Down from that card always found its
  // same-row neighbour first: the check passed with the guard deleted, so it
  // was observing the shelf's geometry and not the guard.

  // ── H12  nothing threw ──────────────────────────────────
  check('H12 no uncaught error during the run', errors.length === 0, errorTail());
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
