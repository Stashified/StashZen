/**
 * Headless driver for Back while the player is open over the performer page:
 * the page and the player both acted on the same press, returning to the full
 * Performers listing instead of the performer.
 *
 * PerformerDetailPage and the player each install a window capture listener,
 * so they run in registration order (the page first) and `stopPropagation`
 * cannot suppress a sibling on the same target. The page's guard asks whether
 * *focus* is inside a dialog, but while the player is open focus is on <body>
 * (the detail page unmounted with Play; the player never focuses its own
 * container, see useControlsVisibility's leaveRail), so the page closed
 * underneath it.
 *
 * The first Back is the player's controls-bar press and must not touch the
 * page; the second closes the player and lands back on the performer, focused
 * on the card that was played. Mounts the real App against the fake GraphQL
 * endpoint.
 *
 * A headless driver cannot prove the TV's remote sends the same keydown; that
 * is the TV pass.
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
const active = () => document.activeElement || document.body;

function press(key, keyCode) {
  active().dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}

// Cards move their short action to keyup when they pass `onLongPress`, so a
// real activation needs both halves. Rail rows and buttons do not care, and
// an extra keyup is inert for them.
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

// The app's own Back is the Tizen code; 27 only reaches the overlays.
async function pressBack() {
  active().dispatchEvent(new KeyboardEvent('keydown', {
    keyCode: 10009, key: 'Escape', bubbles: true, cancelable: true,
  }));
  await sleep(400);
}

async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* still settling */ }
    await sleep(50);
  }
  return false;
}

// The player's overlay by its announced label, not class (CSS-module names
// are hashed); the check is about which layers are up.
const playerDialog = () => [...document.querySelectorAll('[role="dialog"]')]
  .find(d => (d.getAttribute('aria-label') || '').startsWith('Now playing:')) || null;

// Only the performer page has this button, so it also proves the page survived
// rather than being replaced by the Performers grid.
const performerPageOpen = () => !!document.querySelector('button[aria-label="Back to performers"]');

// The rail's current tab; only NavRail sets aria-current.
const railActive = () =>
  document.querySelector('[aria-current="page"]')?.textContent.trim() || '(none)';

async function run() {
  // ── Arrive on the Performers grid ─────────────────────────
  await waitFor(() => registry.has('nav-performers'));
  await sleep(400);   // Home's autoFocus timer runs after mount
  focus('nav-performers');
  await sleep(120);
  await tapEnter();
  // The grid itself, not a card with the same id: Home's showroom shelf uses
  // the same `performer-<id>` registry ids, but opens the page through the
  // showroom origin, a different back path.
  const onGrid = await waitFor(
    () => !!document.querySelector('[aria-label="Performer grid"]'), 4000);
  check('P-1 the Performers grid is the surface under test', onGrid,
    onGrid ? 'performer grid present' : 'still on Home (grid missing)');

  // ── Back from a performer page must return to *that* card ──
  // The grid is swapped out for the detail page (TabContent), so the card is
  // detached while the page is up; focus is restored by id after the grid
  // remounts and refetches.
  //
  // Not performer-1: the first card is where the fallback lands, so asserting
  // it would pass on the broken build. performer-3 is on the same page, which
  // makes the two answers distinguishable.
  await waitFor(() => registry.has('performer-3'));
  focus('performer-3');
  await sleep(120);
  await tapEnter();
  await waitFor(() => performerPageOpen());
  press('Escape', 27);
  // Asserted against the *document's* focus, not `getCurrentFocusId`: that
  // module variable is only cleared when the unmount effect runs, so a
  // detached card can leave it naming the right performer while the browser
  // is on <body>. The element must be live and active.
  const onCard = () => {
    const el = registry.get('performer-3')?.el;
    return !!el && document.contains(el) && document.activeElement === el;
  };
  const t0 = Date.now();
  const backOnCard = await waitFor(() => !performerPageOpen() && onCard(), 8000);
  check('P0 Back returns to the performer that was opened, not the first card',
    backOnCard,
    `page ${performerPageOpen()}, focus ${getCurrentFocusId() ?? '<none>'}, `
      + `${Date.now() - t0} ms`);

  // ── P0b  a card from the third page comes back too ────────
  // Two next-page triggers in one tick (the sentinel plus this restore)
  // fetched the same page, leaving "40 performers" and no further browsing.
  // See pagedlist-entry.jsx, which reproduces that directly. The fake listing
  // has 100 rows, 40 per page, so page 3 is the deep case.
  const performerGrid = () => document.querySelector('[aria-label="Performer grid"]');
  const gridScroller = () => performerGrid()?.parentElement;
  const statsText = () => document.querySelector('[data-list-stats]')?.textContent || '';

  if (gridScroller()) gridScroller().scrollTop = gridScroller().scrollHeight;
  const pageTwo = await waitFor(() => registry.has('performer-60'));
  if (gridScroller()) gridScroller().scrollTop = gridScroller().scrollHeight;
  const pageThree = await waitFor(() => registry.has('performer-90'), 6000);
  check('P0b scrolling the grid reaches the third page',
    pageTwo && pageThree,
    `page 2 card ${pageTwo}, page 3 card ${pageThree}, `
      + `stats "${statsText()}"`);

  const deepCardLive = () => {
    const el = registry.get('performer-85')?.el;
    return !!el && document.contains(el);
  };
  if (await waitFor(deepCardLive, 4000)) {
    focus('performer-85');
    await sleep(120);
    await tapEnter();
    await waitFor(() => performerPageOpen());
    press('Escape', 27);
    const tDeep = Date.now();
    const deepBack = await waitFor(() => {
      const el = registry.get('performer-85')?.el;
      return !performerPageOpen()
        && !!el && document.contains(el) && document.activeElement === el;
    }, 9000);
    check('P0b Back returns to a performer from the third page',
      deepBack,
      `focus ${getCurrentFocusId() ?? '<none>'}, ${Date.now() - tDeep} ms`);
    // The listing, not just the focus: the bug stranded the grid at the rows
    // it had, losing the server's total.
    check('P0b …and the count line still reports the whole library',
      statsText() === '100 performers',
      `stats "${statsText()}"`);
  } else {
    check('P0b Back returns to a performer from the third page', false,
      'performer-85 never mounted');
  }

  // ── A gallery chip from a scene opened on a performer page ──
  // The performer page closes with the tab, so `video-<scene>` names nothing
  // on the grid. Back must land on the performer that opened it, not the first
  // card the fallback would pick.
  await waitFor(() => registry.has('performer-3'));
  await sleep(200);
  focus('performer-3');
  await sleep(120);
  await tapEnter();
  await waitFor(() => performerPageOpen() && registry.has('video-1'));
  focus('video-1');
  await sleep(120);
  await tapEnter();
  await waitFor(() => registry.has('scene-gallery-7001'));
  focus('scene-gallery-7001');
  await sleep(120);
  await tapEnter();
  const onImages = await waitFor(() => railActive() === 'Images', 4000);
  check('P0c the gallery chip opens the Images tab', onImages,
    `rail ${railActive()}`);
  await pressBack();
  const tGallery = Date.now();
  const backOnPerformer = await waitFor(() => {
    const el = registry.get('performer-3')?.el;
    return railActive() === 'Performers'
      && !!el && document.contains(el) && document.activeElement === el;
  }, 9000);
  check('P0c Back returns to the performer that opened the scene',
    backOnPerformer,
    `rail ${railActive()}, focus ${getCurrentFocusId() ?? '<none>'}, `
      + `${Date.now() - tGallery} ms`);

  // ── Open performer-1's page for the player layering checks ──
  await waitFor(() => registry.has('performer-1'));
  await sleep(300);
  focus('performer-1');
  await sleep(120);
  await tapEnter();

  const detailReady = await waitFor(() => performerPageOpen() && registry.has('video-1'));
  check('P0a the performer page opens with its scene grid',
    detailReady,
    `back button ${performerPageOpen()}, video-1 ${registry.has('video-1')}`);

  // ── Open the scene's detail page, then play from it ───────
  // Enter opens the page, Play starts it. App closes the scene page on
  // playback, leaving only the performer page under the player.
  focus('video-1');
  await sleep(120);
  await tapEnter();
  const sceneDetailOpen = await waitFor(() => registry.has('scene-play'));
  check('P1 Enter on a scene card opens its detail page', sceneDetailOpen);

  focus('scene-play');
  await sleep(120);
  await tapEnter();
  const playing = await waitFor(() => !!playerDialog());
  check('P2 Play opens the player over the performer page',
    playing && performerPageOpen(),
    `player ${!!playerDialog()}, performer page ${performerPageOpen()}`);

  // ── Back #1: the controls bar ─────────────────────────────
  // With the bar up the first press puts it away; the performer page must do
  // nothing, it is not the top layer.
  await sleep(200);
  press('Escape', 27);
  await sleep(350);
  check('P3 Back with the player up does not close the page underneath',
    performerPageOpen(),
    `performer page ${performerPageOpen()}`);

  // ── Back #2: the player ───────────────────────────────────
  // Closing reveals the performer page, cursor on the card that was played.
  press('Escape', 27);
  await sleep(450);
  const closed = !playerDialog();
  check('P4 the second Back closes the player', closed);
  check('P5 ... and reveals the performer page, not the Performers grid',
    performerPageOpen(),
    `performer page ${performerPageOpen()}`);
  check('P6 focus returns to the card that was played',
    getCurrentFocusId() === 'video-1',
    getCurrentFocusId() ?? '<none>');
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
root.style.cssText = 'height:100vh;display:flex;flex-direction:column;overflow:hidden;';
document.body.style.margin = '0';

// Before the render, so the first fetch already sees the fake endpoint.
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
