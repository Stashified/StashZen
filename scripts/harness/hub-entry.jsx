/**
 * Headless driver for the performer hub, the new quick-filter chips and
 * Surprise.
 *
 * Mounts the real App: every claim is about wiring two components together.
 * The performer page's own count/tag controls record handlers (performer-entry
 * proves they are D-pad stops); what this driver proves is that the handler
 * switches to the right tab with the right criterion, and that Back returns to
 * the performer page with the cursor on the control that opened the spoke.
 *
 *   H1  the images/galleries counts and a tag chip each activate a filtered
 *       listing, and Back restores the performer page and that control.
 *       A second activation from the spoke unwinds one level at a time, and
 *       Back's declared edges enter the hero instead of skipping it.
 *   H2  the new chips exist on Performers/Tags/Studios, carry the right
 *       criterion (filter_favorites vs favorite), and compose.
 *   H3  Surprise sends one random row through the active filter, opens the
 *       player, and reports an empty answer instead of opening a blank player.
 *       A quick-filter chip must reach that request too, and a late answer
 *       must not open under an overlay the user raised meanwhile.
 *
 * The fake server answers the filtered listings regardless of their criteria;
 * the log is the observable for "the criterion was sent". Back is read from the
 * screen and the focus registry, not the log.
 */

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
const getJSON = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();
const clearLogs = () => fetch(`http://127.0.0.1:${PORT}/clear`, { method: 'POST' });
const setMode = (key, value) => fetch(`http://127.0.0.1:${PORT}/mode`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ [key]: value }),
});

const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});
const errorTail = () => (errors.length ? errors.slice(-2).join(' | ') : 'none');

async function waitFor(pred, ms = 8000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

// The fetch-backed predicates: a poll that has to read the fake's log first.
// `waitFor` would see an async function's Promise and call it satisfied.
async function waitForAsync(pred, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  let ok = false;
  while (Date.now() < end) {
    try { ok = await pred(); } catch { ok = false; }
    if (ok) return true;
    await sleep(step);
  }
  return ok;
}

const active = () => document.activeElement;
function press(key, keyCode) {
  (active() || document.body).dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}
function release(key, keyCode) {
  (active() || document.body).dispatchEvent(new KeyboardEvent('keyup', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}
// Enter fires on keyup for cards declaring longPress and on keydown elsewhere;
// sending both keeps one helper for rail rows, cards and menu rows.
async function tapEnter() {
  press('Enter', 13);
  await sleep(40);
  release('Enter', 13);
  await sleep(180);
}
async function pressBack() {
  press('Escape', 10009);
  await sleep(450);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};
const has = (id) => registry.has(id);
const live = (id) => {
  const el = registry.get(id)?.el;
  return !!el && document.contains(el);
};
const bodyText = () => document.body.textContent || '';
const railActive = () =>
  [...(document.querySelector('nav[aria-label="Main navigation"]')?.querySelectorAll('button') ?? [])]
    .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || '(none)';

async function gotoTab(tab) {
  focus(`nav-${tab}`);
  await sleep(120);
  await tapEnter();
  await sleep(400);
}

const requests = () => getJSON('/requests');
const requestsWith = async (key) => (await requests()).filter(r => r[key]);

async function finish() {
  await fetch(`http://127.0.0.1:${PORT}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch(`http://127.0.0.1:${PORT}/done`, { method: 'POST' });
}

// ── The run ─────────────────────────────────────────────────
async function run() {
  setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });
  await clearLogs();
  createRoot(document.getElementById('root')).render(<App />);

  await waitFor(() => has('nav-home'));
  await sleep(300);

  // ── H1: the performer detail is a hub ───────────────────
  await gotoTab('performers');
  const gridReady = await waitFor(() => live('performer-1'));
  focus('performer-1');
  await tapEnter();
  const detailReady = await waitFor(() => live('performer-images') && live('performer-tag-t1'));
  check('H1 the performer page opens with its count and tag controls',
    gridReady && detailReady && railActive().toLowerCase() === 'performers',
    `grid=${gridReady} detail=${detailReady} rail=${railActive()} errors: ${errorTail()}`);

  /** Open a spoke, read it, then Back and read the return trip. */
  async function spoke({ control, tab, filterKey, matches, label }) {
    await clearLogs();
    focus(control);
    await sleep(80);
    await tapEnter();
    const arrived = await waitFor(() => railActive().toLowerCase() === tab);
    // The request is what says the listing is filtered, not the tab alone.
    const sent = await waitForAsync(async () => {
      const rows = await requestsWith(filterKey);
      return rows.some(r => matches(r[filterKey]));
    }, 3000);
    check(`H1 ${label} opens ${tab}, filtered`, arrived && sent,
      `rail=${railActive()} filtered=${sent} errors: ${errorTail()}`);

    await pressBack();
    // The spoke's tab must give way and the performer page come back with the
    // control that opened it focused. The profile fetch is in flight again, so
    // the target appears a fetch later; focusByIdWhenReady polls for it.
    const back = await waitFor(
      () => railActive().toLowerCase() === 'performers'
        && live(control) && getCurrentFocusId() === control, 8000);
    check(`H1 Back from ${tab} returns to the performer page at "${control}"`,
      back && bodyText().includes('VERIFY performer 1'),
      `rail=${railActive()} live=${live(control)} focus=${getCurrentFocusId()} `
      + `name=${bodyText().includes('VERIFY performer 1')}`);
  }

  // The log records the variables as GraphQL received them, so the criterion's
  // `[{id, label}]` is already flattened to `["1"]`; accept both shapes.
  const idOf = (x) => (typeof x === 'string' ? x : x?.id);
  const performerCriterion = (f) =>
    f?.performers?.modifier === 'INCLUDES' && idOf(f?.performers?.value?.[0]) === '1';

  await spoke({
    control: 'performer-images', tab: 'images', filterKey: 'image_filter',
    matches: performerCriterion, label: 'the image count',
  });
  await spoke({
    control: 'performer-galleries', tab: 'galleries', filterKey: 'gallery_filter',
    matches: performerCriterion, label: 'the gallery count',
  });
  await spoke({
    control: 'performer-tag-t1', tab: 'scenes', filterKey: 'scene_filter',
    matches: (f) => f?.tags?.modifier === 'INCLUDES' && idOf(f?.tags?.value?.[0]) === 't1',
    label: 'a tag chip',
  });

  // ── H1c: Back's declared edges enter the hero ────────────
  // The back button sits in its own zone, so Down used to skip the whole hub
  // row into the controls bar and Right was dead (horizontal moves never cross
  // zones).
  focus('detail-back');
  await sleep(80);
  press('ArrowDown', 40);
  await sleep(220);
  const downFromBack = getCurrentFocusId();
  focus('detail-back');
  await sleep(80);
  press('ArrowRight', 39);
  await sleep(220);
  const rightFromBack = getCurrentFocusId();
  check('H1c Down and Right from Back enter the hub controls',
    downFromBack === 'performer-images' && rightFromBack === 'performer-images',
    `down=${downFromBack} right=${rightFromBack}`);

  // ── H1b: a second level from the spoke ──────────────────
  // The hub is a stack, not one hop: a gallery card on the performer's
  // galleries spoke opens Images, and each Back must unwind one level rather
  // than drop the performer or raise the exit prompt.
  await clearLogs();
  focus('performer-galleries');
  await sleep(80);
  await tapEnter();
  await waitFor(() => railActive().toLowerCase() === 'galleries');
  await waitFor(() => live('gallery-1'));
  focus('gallery-1');
  await sleep(80);
  await tapEnter();
  const gallerySpoke = await waitFor(() => railActive().toLowerCase() === 'images');
  check('H1b a gallery card on the galleries spoke opens Images',
    gallerySpoke, `rail=${railActive()}`);

  await clearLogs();
  await pressBack();
  const backToGalleries = await waitFor(
    () => railActive().toLowerCase() === 'galleries' && getCurrentFocusId() === 'gallery-1', 8000);
  const galleriesRefiltered = await waitForAsync(async () => (await requests())
    .some(r => r.gallery_filter?.performers?.value?.[0] === '1'), 4000);
  check('H1b Back returns to the spoke with its filter and the card focused',
    backToGalleries && galleriesRefiltered,
    `rail=${railActive()} focus=${getCurrentFocusId()} filtered=${galleriesRefiltered}`);

  await pressBack();
  const backToPerformer = await waitFor(
    () => railActive().toLowerCase() === 'performers'
      && live('performer-galleries') && getCurrentFocusId() === 'performer-galleries', 8000);
  check('H1b Back again returns to the performer page at the control',
    backToPerformer && bodyText().includes('VERIFY performer 1'),
    `rail=${railActive()} focus=${getCurrentFocusId()} `
    + `name=${bodyText().includes('VERIFY performer 1')}`);
  check('H1 the performer hub left no uncaught error',
    errors.length === 0, errorTail());

  // Back out of the performer page to its listing for the chip phases.
  await pressBack();
  await waitFor(() => live('performer-1'));

  // ── H2: the new quick-filter chips ──────────────────────
  // Performers spell the flag `filter_favorites`; Tags and Studios use
  // `favorite`. A chip sitting on the wrong tab looks identical in the DOM.
  await clearLogs();
  const performerChip = live('quick-filterFavorites') && !live('quick-favorite');
  focus('quick-filterFavorites');
  await sleep(80);
  await tapEnter();
  const performerFiltered = await waitForAsync(async () => (await requests())
    .some(r => r.performer_filter?.filter_favorites === true), 3000);
  check('H2 Performers offers a Favourites chip that sends filter_favorites',
    performerChip && performerFiltered
      && registry.get('quick-filterFavorites')?.el.getAttribute('aria-pressed') === 'true',
    `chip=${performerChip} sent=${performerFiltered} `
    + `pressed=${registry.get('quick-filterFavorites')?.el.getAttribute('aria-pressed')}`);

  await gotoTab('tags');
  await waitFor(() => live('tag-1'));
  await clearLogs();
  const tagChips = live('quick-favorite') && !live('quick-rated4');
  focus('quick-favorite');
  await sleep(80);
  await tapEnter();
  const tagFiltered = await waitForAsync(async () => (await requests())
    .some(r => r.tag_filter?.favorite === true), 3000);
  check('H2 Tags offers Favourites only, and says favorite',
    tagChips && tagFiltered,
    `chips=${tagChips} sent=${tagFiltered} errors: ${errorTail()}`);

  await gotoTab('studios');
  await waitFor(() => live('studio-1'));
  await clearLogs();
  const studioChips = live('quick-favorite') && live('quick-rated4');
  focus('quick-rated4');
  await sleep(80);
  await tapEnter();
  const rated = await waitForAsync(async () => (await requests())
    .some(r => r.studio_filter?.rating100?.value === 39
      && r.studio_filter?.rating100?.modifier === 'GREATER_THAN'), 3000);
  focus('quick-favorite');
  await sleep(80);
  await tapEnter();
  // Two chips occupy distinct fields, so the second request must carry both.
  const composed = await waitForAsync(async () => (await requests()).some(r =>
    r.studio_filter?.favorite === true && r.studio_filter?.rating100?.value === 39), 3000);
  check('H2 Studios offers Favourites and Rated 4+, and the two compose',
    studioChips && rated && composed,
    `chips=${studioChips} rated=${rated} composed=${composed} errors: ${errorTail()}`);

  // ── H3: Surprise ────────────────────────────────────────
  await gotoTab('scenes');
  await waitFor(() => live('video-1'));
  await clearLogs();
  const surpriseExists = has('ctrl-surprise');
  focus('ctrl-surprise');
  await sleep(80);
  await tapEnter();
  const playing = await waitFor(
    () => !!document.querySelector('[role="dialog"][aria-label^="Now playing:"]'), 5000);
  const surpriseRequest = await waitForAsync(async () => (await requests())
    .some(r => r.sort === 'random' && r.per_page === 1), 3000);
  check('H3 Surprise sends one random row and opens the player',
    surpriseExists && playing && surpriseRequest,
    `button=${surpriseExists} player=${playing} request=${surpriseRequest} errors: ${errorTail()}`);
  const playerLabel = document.querySelector('[role="dialog"][aria-label^="Now playing:"]')
    ?.getAttribute('aria-label') || '';
  check('H3 ...with the scene the fetch returned',
    playerLabel.includes('VERIFY scene 1'), `label="${playerLabel}"`);

  // Back is one level up: the first press puts the controls bar away, the
  // second closes the player (keyRouting R7).
  await pressBack();
  await pressBack();
  const playerClosed = await waitFor(
    () => !document.querySelector('[role="dialog"][aria-label^="Now playing:"]'), 5000);
  const backToSurprise = await waitFor(() => getCurrentFocusId() === 'ctrl-surprise', 3000);
  check('H3 Back closes the player and returns to Surprise',
    playerClosed && backToSurprise,
    `closed=${playerClosed} focus=${getCurrentFocusId()}`);

  await setMode('findScenes', 'random-empty');
  await clearLogs();
  focus('ctrl-surprise');
  await sleep(80);
  await tapEnter();
  const noticed = await waitFor(
    () => bodyText().includes('No scene matches the current filter.'), 4000);
  const noPlayer = !document.querySelector('[role="dialog"][aria-label^="Now playing:"]');
  check('H3 an empty answer is reported and opens no player',
    noticed && noPlayer, `notice=${noticed} player=${!noPlayer}`);
  await setMode('findScenes', 'ok');

  // ── H3b: a chip narrows the random pick too ──────────────
  // "Through the current filter" is the button's whole promise; a chip that
  // only narrowed the grid would look right and play the wrong scene.
  focus('quick-unwatched');
  await sleep(80);
  await tapEnter();
  const chipOn = await waitFor(
    () => registry.get('quick-unwatched')?.el?.getAttribute('aria-pressed') === 'true', 3000);
  await clearLogs();
  focus('ctrl-surprise');
  await sleep(80);
  await tapEnter();
  await waitFor(() => !!document.querySelector('[role="dialog"][aria-label^="Now playing:"]'), 5000);
  const chipCarried = await waitForAsync(async () => (await requests())
    .some(r => r.sort === 'random' && r.per_page === 1
      && JSON.stringify(r.scene_filter || {}).includes('play_count')), 4000);
  check('H3b Surprise folds the active chip into its random request',
    chipOn && chipCarried, `chip=${chipOn} carried=${chipCarried}`);
  await pressBack();
  await pressBack();
  await waitFor(() => !document.querySelector('[role="dialog"][aria-label^="Now playing:"]'), 5000);

  // ── H3c: a slow answer cannot land under an overlay ──────
  // The answer can arrive up to the client timeout later; by then the user
  // may be reading a scene. It must not close that page or autoplay beneath.
  await setMode('findScenes', 'slow');
  focus('ctrl-surprise');
  await sleep(80);
  await tapEnter();
  await sleep(60);
  focus('video-1');
  await tapEnter();
  // Any modal that is not the player is the detail page.
  const detailSelector = '[role="dialog"][aria-modal="true"]:not([aria-label^="Now playing:"])';
  const detailOpen = await waitFor(() => !!document.querySelector(detailSelector), 4000);
  check('H3c a scene opens while the random fetch is in flight',
    detailOpen, `detail=${detailOpen} focus=${getCurrentFocusId()}`);
  await sleep(1600);   // past the fake's 1 s delay
  const stillDetail = !!document.querySelector(detailSelector);
  const playerUnder = !!document.querySelector('[role="dialog"][aria-label^="Now playing:"]');
  check('H3c the late answer does not replace the open scene detail',
    stillDetail && !playerUnder, `detail=${stillDetail} player=${playerUnder}`);
  await pressBack();
  await setMode('findScenes', 'ok');

  check('H3 the whole run left no uncaught error', errors.length === 0, errorTail());
  await finish();
}

run().catch(async (e) => {
  results.push({
    name: 'HARNESS CRASHED',
    pass: false,
    detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
  });
  try { await finish(); } catch { /* nothing left to do */ }
});
