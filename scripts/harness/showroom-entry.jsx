/**
 * Headless driver for Home as a showroom.
 *
 * Mounts the whole `App`: each claim pairs two things, a shelf and its
 * request, a See-all tile and the tab it opens, a tab's Back and the shelf it
 * returns to.
 *
 *   H1–H4  five fixed shelves in Stash's order, Continue Watching directly
 *          below Recently Released Scenes; five cards plus a See-all tile
 *          last, so Right past the fifth card reaches it.
 *   H2b    TV geometry: bigger cards and three shelves on the first screen,
 *          measured from rects at 1920x1080.
 *   H4b–e  each shelf sends its own query, read from `/requests`; a wrong sort
 *          still renders. Continue Watching also needs `resume_time > 0`, and
 *          the fake returns a distinctive subset so the DOM can agree.
 *   H7–H14 the See-all hand-off carries the shelf's sort, order and filter;
 *          for Continue Watching, Studios and Galleries these differ from the
 *          tab default, and `sortForTab` marks the sort deliberate.
 *   H18    the hand-off marker is consumed: an ordinary Studios arrival reads
 *          Name, not staged Date Added; the Scenes filter is dropped.
 *   H15–H17 a performer card returns to the same card via `performerOrigin`;
 *          a studio or gallery routes through the filter machinery.
 *   H23    the stale shelf card still asks: the detail page's uncached fetch
 *          is the fresh position, and Play must carry it into the queue.
 *
 * TV pass: whether five shelves read as a showroom, overscan, and how the
 * cards look on the panel.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry, getCurrentFocusId } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;

// Written out, not imported from ShowroomPage: importing the rendered table
// would make intent and output agree by construction. Five is the contract the
// six-column grid and the "See all" tile are built on.
const SHELF = 5;
const SHELVES = [
  {
    key: 'recent-scenes', heading: 'Recently Added Scenes',
    prefix: 'showroom-recent-scenes-video', tile: 'showroom-seeall-recent-scenes',
  },
  {
    key: 'continue-watching', heading: 'Continue Watching',
    prefix: 'showroom-continue-video', tile: 'showroom-seeall-continue',
    // Card ids carry the scene id, and the fake answers `resume_time > 0` with
    // 41–45; other shelves use 1..5. Writing this out keeps the check about the
    // prefix, not a fixture coincidence.
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
// Dispatch on the focused element with `bubbles` to reach both listeners;
// 150 ms between presses clears MIN_REPEAT_MS.
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
 * Close the player in the presses the remote needs: Back hides the bar before
 * closing the player. The 0.4 s pause lets the fade finish and the listener
 * update; if the bar had auto-hidden, retry once so this is not an extra press
 * on the screen below.
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

/** Open the Sort dropdown, choose a value, close it again, the three presses
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

/** "No criteria" on the wire is `{}`, not null: `translateFilter` returns an
 *  empty GraphQL input. Assert emptiness to test the intent without pinning
 *  the encoding. */
const unfiltered = (filter) => !filter || Object.keys(filter).length === 0;

const railActive = () =>
  [...(document.querySelector('nav[aria-label="Main navigation"]')?.querySelectorAll('button') ?? [])]
    .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || '(none)';

const sortText = () => registry.get('ctrl-sort')?.el.textContent?.trim() ?? '(none)';
const filterText = () => registry.get('ctrl-filter')?.el.textContent?.trim() ?? '(none)';
const descPressed = () => registry.get('ctrl-desc')?.el.getAttribute('aria-pressed');

/** Registry ids of a prefix whose element is still connected: the registry
 *  outlives unmounted cards, but only a connected element is visible. */
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
  // Gate on DOM shape, not a focus id: the id prefix is under test, so a card
  // gate would report a broken prefix as "Home never loaded". Five sections
  // render only after all five fetches resolve, so they mean shelves are final.
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
  // Recently Added Scenes is the top shelf, so its first card autofocuses;
  // every other shelf passes `autoFocus` false so five cards do not race.
  // PerformerCard once defaulted to `index === 0`, hence the named detail.
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
  // Bigger cards, three shelves on the first screen. Read rects, not
  // arithmetic: a font metric or extra margin is how "three rows fit" silently
  // stops being true. Measure the second card because the first is focus-scaled.
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

    // One card footprint on all shelves: the performer row's 3:4 portrait
    // cards were 347 px tall against 211 for scenes and 151 for studios and
    // galleries. Read the first strip cell (never focus-scaled), rounded.
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

    // Equal wrappers are not enough: a card keeping its aspect ratio would
    // leave a blank strip or clip the overlay. The scene shelves have an info
    // bar below the art; the other three overlay text on the full card face.
    const artGap = Object.fromEntries(SHELVES.map(s => {
      const card = stripOf(s.key)?.children[0]?.firstElementChild;
      if (!card) return [s.key, 'no card'];
      const cr = card.getBoundingClientRect();
      // Scene shelves measure fill against the info bar; overlay rows use the
      // whole first child. Branch on kind, not one key, or Continue Watching
      // falls into the overlay branch and reports the bar height as a gap.
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

  // Each shelf draws its own card family. A gallery row using the studio
  // descriptor would look fine, register `studio-*` ids, open the wrong detail
  // and collide with the studios shelf.
  for (const shelf of SHELVES) {
    // The first slot is a `.cell` wrapper (it owns the shelf's fixed height);
    // the card whose focus id proves the card family is its first child.
    const first = stripOf(shelf.key)?.firstElementChild?.firstElementChild;
    const expected = shelf.firstId || `${shelf.prefix}-1`;
    check(`H4f ${shelf.key}: the first slot holds a ${shelf.prefix} card`,
      idOfEl(first) === expected, `first slot is ${idOfEl(first)}, wanted ${expected}`);
  }

  // ── H4b–e  each shelf's own request ─────────────────────
  // Verify the shelf table at the wire via `/requests`, not at the table. The
  // limit of five tells a shelf apart from the tab.
  const reqs = await getJSON('/requests');
  const sceneShelves = reqs.filter(r => r.scene_filter !== undefined && r.per_page === SHELF);
  const studioShelves = reqs.filter(r => r.studio_filter !== undefined && r.per_page === SHELF);
  const performerShelves = reqs.filter(r => r.performer_filter !== undefined && r.per_page === SHELF);
  const galleryShelves = reqs.filter(r => r.gallery_filter !== undefined && r.per_page === SHELF);

  // `date` is the release date, so an old film added today would miss the
  // shelf; `created_at` is arrival order and the Scenes tab's default.
  const scenesReq = sceneShelves.find(r => r.sort === 'created_at');
  check('H4b the Scenes shelf asks for created_at, descending, unfiltered',
    !!scenesReq && scenesReq.direction === 'DESC' && unfiltered(scenesReq.scene_filter),
    scenesReq ? JSON.stringify(scenesReq)
      : `no per_page=${SHELF} FindScenes sorted by created_at`);

  // Continue Watching is also a filter. Assert both halves: without
  // `resume_time` this would be five plausible newest scenes sorted by play date.
  const continueReq = sceneShelves.find(r => r.sort === 'last_played_at');
  const continueCriterion = continueReq?.scene_filter?.resume_time || {};
  const continueValue = typeof continueCriterion.value === 'object'
    ? continueCriterion.value?.value
    : continueCriterion.value;
  check('H4b2 the Continue Watching shelf asks for last_played_at, descending, resume_time > 0',
    !!continueReq && continueReq.direction === 'DESC'
      && continueCriterion.modifier === 'GREATER_THAN' && continueValue === 0,
    continueReq ? JSON.stringify(continueReq) : `no per_page=${SHELF} FindScenes sorted by last_played_at`);

  // The DOM agrees: the fake returns 41–45 for `resume_time > 0` and 1..N
  // otherwise. Read the aria-label, which carries the title alone; textContent
  // appends resolution and year, where "…scene 41" matches "…scene 412".
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
  // The first card of each shelf sits directly under the first card above it.
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

  // Up must restore the top of Home, not merely the first card.
  // `block:'nearest'` aligns the card's top with the scrollport, leaving the
  // page padding and shelf heading above the fold and clipping the card's
  // focus-scaled, lifted top.
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
  // The shelf asks for `created_at`, also the Scenes default, so the listing
  // may already be cached. Accept a cache hit or a matching
  // created_at/desc/unfiltered request; a release-date (`date`) press fails.
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

  // ── H19  Continue Watching See all ─────────────────────
  // The only filtered hand-off. Four independent claims: the criterion and
  // sort reached the wire; the control reads the shelf's sort, not the tab
  // default; the dropdown names the shelf; and the rendered count proves the
  // listing applied the filter (the fake returns exactly five scenes).
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
  // Choose Title on Scenes, return Home and press the tile. Since the shelf
  // sort now equals the tab default, this only asserts Title does not survive;
  // H18b is the discriminating staged-sort check.
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

  // ── H18  the hand-off marker and filter do not outlive arrival ─
  // An ordinary Scenes arrival from the rail must show the tab default. The
  // sort half only proves Title did not survive (H18b covers a differing
  // staged sort); the filter half still proves the Continue Watching criterion
  // is gone, so Scenes is All.
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
  // control discriminates as well as the wire.
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

  // ── H18b  the Studios hand-off marker does not outlive arrival ─
  // The shelf stages `created_at` against Name, so a leftover marker would keep
  // Date Added. H9 consumed the marker; arriving from the rail again must read
  // Name. This carries the claim H18 lost when Scenes moved to its default sort.
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
  // The shelf sort equals the tab default, so the control cannot distinguish
  // marker from default; destination, wire and focus are the claims.
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
  // A detail opened from the See-all Performers listing returns there first.
  // `performerOrigin` is separate from `filterOrigin`, which would jump Home.
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
  // Galleries default to Date Added; the shelf asks for Date. Compare the
  // control text exactly: a /Date/ regex also matches "Date Added".
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
  // The detail renders only under Performers, so this crosses a tab switch.
  // `performerOrigin` names the Home card; restore uses `focusByIdWhenReady`
  // because Home remounts and refetches.
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
  // Home stays mounted under the overlay, so its five requests do not re-run.
  // The page reports the cleared id, App passes it on, and the card goes. Back
  // then falls back to the page's first control, since that card is gone.
  await waitFor(() => registry.has('showroom-continue-video-41'), 4000);
  await clearLogs();
  focus('showroom-continue-video-41');
  await sleep(120);
  await tapEnter();
  const clearOffered = await waitFor(
    () => registry.has('scene-clear-progress')
      && registry.get('scene-clear-progress').el.getAttribute('aria-disabled') !== 'true',
    5000);
  focus('scene-clear-progress');
  await tapEnter();
  const cleared = await waitFor(
    () => /Progress cleared/.test(document.body.textContent), 3000);
  // The press itself mutes the button. `aria-disabled`, not native, so the ring
  // stays where the user put it instead of falling to <body>. Checked before
  // Back, which moves it on purpose.
  check('H21 ...and the ring stays on the button it was pressed from',
    focusedId() === 'scene-clear-progress'
      && registry.get('scene-clear-progress').el.getAttribute('aria-disabled') === 'true',
    `focus is ${focusedId()}, aria-disabled=`
    + `${registry.get('scene-clear-progress').el.getAttribute('aria-disabled')}`);
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
  // Play builds the queue from the card, which still carries `resume_time` 60
  // when Clear progress runs. App patches it on the page's report; without the
  // patch the next press asks "Resume from 1:00?" about a discarded position.
  await waitFor(() => registry.has('showroom-continue-video-42'), 4000);
  focus('showroom-continue-video-42');
  await sleep(120);
  await tapEnter();
  const clear42 = await waitFor(
    () => registry.has('scene-clear-progress')
      && registry.get('scene-clear-progress').el.getAttribute('aria-disabled') !== 'true',
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
  // Close the scene-42 page under the player so the next check starts at the shelf.
  await pressBack();
  await waitFor(() => !document.querySelector('[role="dialog"]'), 3000);

  // ── H23  a stale card still asks, because the detail fetch is fresh ─
  // Play, pause, Back: the shelf is not refetched, so its card still says
  // `resume_time` 0 while Stash holds a position. The detail page's uncached
  // `FindSceneDetail` is the fresh answer and Play must carry it into the queue.
  // Both reads return 22, which made the old failure a silent seek.
  await setMode({ detailResume: 22, resume: 22 });
  await waitFor(() => registry.has('showroom-recent-scenes-video-1'), 4000);
  const detailBefore = (await getJSON('/detailfetches')).length;
  focus('showroom-recent-scenes-video-1');
  await sleep(120);
  await tapEnter();
  await waitFor(() => registry.has('scene-play'), 4000);
  // `scene-play` registers from the card-first paint. Wait for the fresh fetch,
  // or Play forwards the stale 0 this check exists to catch.
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
  // Answer "start from the beginning" and confirm the declined position is
  // not applied anyway.
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
  // Close the scene-1 detail page under the player so the last check starts at Home.
  await pressBack();
  await waitFor(() => !document.querySelector('[role="dialog"]'), 3000);

  // The rail-row guard is checked in rail-entry (R11) against a listing that
  // has ended. An earlier H24 here read Home's bottom shelf, but Down always
  // found a same-row neighbour first, so it passed with the guard deleted.

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
