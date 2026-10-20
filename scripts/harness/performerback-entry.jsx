/**
 * Headless driver for Back while the player is open over the performer page.
 *
 * The report (2026-10-20): "backing out from playing a scene, selected from
 * the performer page, returns back to full performer listing (not the
 * performer we were at)". Which is to say the *page* and the *player* both
 * acted on the same Back press.
 *
 * Two independent listeners claim Back here. PerformerDetailPage installs one
 * on mount with `isBackKey(e) && !focusScopeOf(document.activeElement)` as its
 * guard; the player installs one when it mounts. Both are window capture
 * listeners, so they run in registration order — the page first, because it
 * was there first — and `stopPropagation` cannot suppress a sibling listener
 * on the same target. The page's guard asks whether *focus* is inside a
 * dialog, and while the player is open focus is on <body> (the detail page
 * unmounted with the Play press and the player deliberately never focuses its
 * own container — see useControlsVisibility's leaveRail), so the guard sees
 * nothing and the page closes itself underneath the player.
 *
 * The assertions are ordered so the difference is visible rather than just
 * red: the first Back is the player's controls-bar press, and it must not
 * touch the page. The second closes the player and must land back on the
 * performer, with focus on the card that was played.
 *
 * Mounts the real App against the fake GraphQL endpoint, like menu-entry.
 *
 * What this cannot tell you: whether the TV's remote sends the same keydown
 * this driver does. Nothing here is timing-sensitive in that way (the keys
 * are real events through the real hooks), but the remote itself is the TV
 * pass.
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

async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* still settling */ }
    await sleep(50);
  }
  return false;
}

// The player's own overlay, by the label it announces rather than by class —
// the CSS-module name is hashed, and the check is about which layers are up.
const playerDialog = () => [...document.querySelectorAll('[role="dialog"]')]
  .find(d => (d.getAttribute('aria-label') || '').startsWith('Now playing:')) || null;

// Only the performer page has this button; the Performers grid (the wrong
// destination) has no such label, so it is also the assertion that the page
// underneath survived rather than being replaced by the listing.
const performerPageOpen = () => !!document.querySelector('button[aria-label="Back to performers"]');

async function run() {
  // ── Arrive on the Performers grid ─────────────────────────
  await waitFor(() => registry.has('nav-performers'));
  await sleep(400);   // Home's autoFocus timer runs after mount
  focus('nav-performers');
  await sleep(120);
  await tapEnter();
  // The grid itself, not merely a card with the same id: Home's showroom
  // carries a performer shelf whose cards use the same `performer-<id>`
  // registry ids, so "performer-3 exists" is true on Home too — and taking
  // that card opens the page through the *showroom* origin, which returns to
  // Home by id. That is a different path from the one this driver is about.
  const onGrid = await waitFor(
    () => !!document.querySelector('[aria-label="Performer grid"]'), 4000);
  check('P-1 the Performers grid is the surface under test', onGrid,
    onGrid ? 'performer grid present' : 'still on Home (grid missing)');

  // ── Back from a performer page must return to *that* card ──
  // The Performers grid is swapped out for the detail page (TabContent), so
  // the card's element is detached while the page is up; the restored focus
  // has to be by id, after the grid has remounted and fetched again. The TV
  // report was "backing out ... returns to full performer listing (not the
  // performer we were at)".
  //
  // Not performer-1: the first card is where the *fallback* lands — a card
  // autofocuses when nothing else has the cursor — so asserting it would pass
  // on the broken build. performer-3 is mounted in the same first page, which
  // makes the two answers distinguishable.
  await waitFor(() => registry.has('performer-3'));
  focus('performer-3');
  await sleep(120);
  await tapEnter();
  await waitFor(() => performerPageOpen());
  press('Escape', 27);
  // The assertion is against the *document's* focus, not `getCurrentFocusId`:
  // that module variable is only cleared when the unmount effect runs, so a
  // detached card can leave it naming the right performer while the browser
  // is actually focused on <body>. The element must be live and it must be
  // the active one.
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
  // TV report, 2026-10-20: after scrolling to a performer past 200 and backing
  // out, "it won't go the one we were on. Performers count also stays at 40
  // and cannot be browsed past first 40." The count moving from "40 of 1,892"
  // to "40 performers" is the listing's no-progress stop having fired, and the
  // cause was two next-page triggers in one tick (the sentinel plus this
  // restore) both fetching the same page — see pagedlist-entry.jsx, which
  // reproduces that directly.
  //
  // The fake listing has 100 rows, 40 per page, so page 3 is the deep case.
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
    // The listing, not just the focus: the bug left the grid stuck at the rows
    // it had when the duplicate page arrived, with the server's total lost.
    check('P0b …and the count line still reports the whole library',
      statsText() === '100 performers',
      `stats "${statsText()}"`);
  } else {
    check('P0b Back returns to a performer from the third page', false,
      'performer-85 never mounted');
  }

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
  // The ordinary path: Enter on a card opens the page, Play starts it. The
  // page is what App closes when playback starts, so the only page left
  // underneath the player is the performer page.
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
  // The player layers Back: with its bar up, the first press puts the bar
  // away. The performer page must observe that and do nothing — it is not the
  // top layer.
  await sleep(200);
  press('Escape', 27);
  await sleep(350);
  check('P3 Back with the player up does not close the page underneath',
    performerPageOpen(),
    `performer page ${performerPageOpen()}`);

  // ── Back #2: the player ───────────────────────────────────
  // And when the player does close, what is revealed is the performer page,
  // with the cursor back on the card that was played.
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
