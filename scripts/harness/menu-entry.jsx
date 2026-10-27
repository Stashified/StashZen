/**
 * Headless driver for the play queue, the long-press menu, and the resume
 * saves that the queue puts at risk.
 *
 * Mounts the real App, not a re-composition of its parts, because most of
 * what 2c adds is *wiring*: which component hands the listing to which, and
 * which of the four places that call `saveSceneActivity` gets the position
 * right. A driver that re-created App's handlers would test a copy of the
 * thing under test.
 *
 * The endpoint is fake (scripts/harness/server.py) and everything else is
 * shipped code. Chosen with `?view=keys` (default), `menu`, `queue` or
 * `saves`.
 *
 * The one thing no DOM can tell you: whether a real remote emits `keyup` for
 * its Enter/OK key. The long-press design depends on it, a remote that only
 * sends keydown would never fire the short action at all. That check is on
 * the TV, with the TV's own remote.
 */

import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const VIEW = new URLSearchParams(location.search).get('view') || 'keys';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The fake listing: 100 rows at a page size of 40. See server.py.
const TOTAL = 100;

const active = () => document.activeElement;

// useFocusable listens on the *element*, useKeyHandler on the window, so every
// key must be dispatched at the focused element and bubble from there, a
// window dispatch misses the per-element handlers entirely.
function press(key, keyCode, { repeat = false } = {}) {
  const el = active() || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true, repeat,
  }));
}

function release(key, keyCode) {
  const el = active() || document.body;
  el.dispatchEvent(new KeyboardEvent('keyup', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}

// Hold Enter the way a remote does: keydown, ~30 Hz auto-repeat, keyup. The
// repeats are the point: unflagged keydowns leave `longPressFired` as the only
// thing stopping a second timer from arming behind the first.
async function holdEnter(ms, { repeatEvery = 90, withRepeatFlag = true } = {}) {
  press('Enter', 13);
  const end = performance.now() + ms;
  while (performance.now() + repeatEvery < end) {
    await sleep(repeatEvery);
    press('Enter', 13, { repeat: withRepeatFlag });
  }
  await sleep(Math.max(0, end - performance.now()));
  release('Enter', 13);
}

// Poll until `pred` holds, up to `ms`. Used where the app deliberately defers
// something past the end of the opening press: the assertion is "it gets
// there", not "it is there by the time I happened to look".
async function waitFor(pred, ms = 1500, step = 25) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

const focusCard = (id) => {
  const entry = registry.get(`video-${id}`);
  if (entry) entry.el.focus();
  return !!entry;
};

const cardEl = (id) => registry.get(`video-${id}`)?.el || null;

// The player's own <video>. There is exactly one on the page.
const mediaEl = () => document.querySelector('video');

const saves = () => fetch('/saves').then(r => r.json());
const setMode = (patch) => fetch('/mode', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
}).then(r => r.json());
const requests = () => fetch('/requests').then(r => r.json());
const clearLogs = () => fetch('/clear', { method: 'POST' });

const MENU = '[role="dialog"][aria-label^="Actions for"]';
const PLAYER = '[role="dialog"][aria-label^="Now playing"]';
// The detail page's dialog is labelled with the scene title, and the fake
// detail scene has one fixed title. See server.py.
const DETAIL = '[role="dialog"][aria-label="VERIFY — detail page harness"]';

// The label span, not the row: each row also carries a hint ("from the
// start", "97 left"), and textContent would glue the two together.
const menuLabels = () =>
  [...document.querySelectorAll(`${MENU} button`)].map(b => b.firstElementChild?.textContent.trim());

const menuOpen = () => !!document.querySelector(MENU);
const playerOpen = () => !!document.querySelector(PLAYER);
const detailOpen = () => !!document.querySelector(DETAIL);

// Every overlay a card press could raise; assertions about *nothing* happening
// must name all of them, watching only the menu and player stayed green while
// the control opened the detail page behind them.
const NO_OVERLAY = () => !detailOpen() && !menuOpen() && !playerOpen();
const ONLY_MENU = () => menuOpen() && !detailOpen() && !playerOpen();
const overlayState = () => `detail ${detailOpen()}, menu ${menuOpen()}, player ${playerOpen()}`;
const inMenu = () =>
  !!document.querySelector(MENU)?.contains(document.activeElement);

// `active()?.textContent` is the whole document when focus falls through to
// <body>, which makes a failure detail unreadable rather than informative.
const focusLabel = () => {
  const el = active();
  if (!el || el === document.body) return '<body — focus escaped>';
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
  return `${el.tagName.toLowerCase()}: ${text.slice(0, 40)}`;
};

/**
 * Close the player, in the presses the remote now needs.
 *
 * Every transport action shows the controls, so at the end of a playback run
 * the bar is up and the first Back only puts it away (see keyRouting.js).
 * Two presses here, with the bar's 0.25 s fade between them, so the driver
 * asserts the thing it is about rather than the layering by accident.
 */
async function closePlayer() {
  press('Backspace', 10009);
  await sleep(350);
  press('Backspace', 10009);
  await sleep(800);
}

// The scene id the player is showing, read off its own aria-label-free DOM:
// the heading is the title, and the fake listing titles are "VERIFY scene N".
const playingTitle = () =>
  document.querySelector(`${PLAYER} h2`)?.textContent || '';
const playingScene = () => {
  const m = playingTitle().match(/VERIFY scene (\d+)/);
  return m ? Number(m[1]) : null;
};

// ── Stepping the queue by key ───────────────────────────────
// The vertical keys are a two-stop ladder: with the seek bar up, ↓ first
// reveals the buttons; `stepNext` spots the rail's ⏯ and retries, `stepPrev` mirrors.
const railFocused = () =>
  ['Play', 'Pause'].includes(document.activeElement?.getAttribute?.('aria-label'));

async function stepNext() {
  if (railFocused()) {
    press('ArrowDown', 40);
  } else {
    press('ArrowDown', 40);
    await sleep(130);
    if (railFocused()) press('ArrowDown', 40);
  }
  await sleep(130);
  active()?.blur?.();
}

async function stepPrev() {
  if (railFocused()) {
    press('ArrowUp', 38);
    await sleep(130);
  }
  press('ArrowUp', 38);
  await sleep(130);
  active()?.blur?.();
}

// ── Long press ──────────────────────────────────────────────
// A tap fires the short action once and only on keyup; a hold fires the menu and
// nothing else; moving off the card mid-press cancels both.
async function runKeys() {
  await sleep(900);
  check('K1 the grid loaded', !!cardEl('1'), 'video-1 in the focus registry');

  // ── A tap ────────────────────────────────────────────────
  focusCard('1');
  press('Enter', 13);
  await sleep(150);
  // Still held: nothing may have happened yet, the observable difference from
  // the old instant-on-keydown behaviour. The predicate must name every overlay
  // a short action could open; watching only menu+player stayed green.
  check('K2 a held Enter does nothing while it is held', NO_OVERLAY(), overlayState());

  release('Enter', 13);
  await sleep(400);
  // Enter on a card opens the detail page (2b), which is the short action.
  check('K2 releasing a tap runs the short action',
    detailOpen(), `detail overlay: ${detailOpen()}`);

  // Close it again. The detail page stops Back on the capture phase, so this
  // also proves the tap left a real, dismissible overlay rather than a
  // half-mounted one.
  press('Escape', 27);
  await sleep(400);
  check('K2 the overlay closed again', NO_OVERLAY(), 'back to the grid');

  // ── A hold ───────────────────────────────────────────────
  // Held with the remote's auto-repeat left in, because a hold on a real
  // remote is never a single clean keydown. holdEnter releases the key too.
  focusCard('2');
  await holdEnter(900);
  await sleep(250);
  // Open, and *only* open: a hold must not also have run the short action.
  check('K3 holding opens the menu', ONLY_MENU(), overlayState());
  check('K3 the menu offers the four actions',
    menuLabels().join('|').includes('Play') &&
    menuLabels().join('|').includes('Play all') &&
    menuLabels().join('|').includes('Play from here') &&
    menuLabels().join('|').includes('Details'),
    menuLabels().join(', '));
  // Covers the keyup half of the hold, the repeats having already gone in.
  check('K3 the keyup after a hold is swallowed', ONLY_MENU(), overlayState());

  // ── A hold whose repeats are unflagged ───────────────────
  // A remote need not set `e.repeat`, leaving `longPressFired` as the only guard
  // against a second timer, which re-records lastMenuCardRef from a menu row.
  press('Escape', 27);
  await sleep(300);
  focusCard('6');
  await holdEnter(900, { repeatEvery: 90, withRepeatFlag: false });
  await sleep(900);          // long enough for a stray second timer to fire
  const sixStillThere = !!cardEl('6');
  press('Escape', 27);
  await sleep(300);
  check('K3 unflagged repeats do not arm a second long press',
    sixStillThere && NO_OVERLAY() && active() === cardEl('6'),
    `${overlayState()}, card 6 present: ${sixStillThere}, focus: ${focusLabel()}`);

  // ── Movement cancels ─────────────────────────────────────
  focusCard('3');
  press('Enter', 13);
  await sleep(120);
  focusCard('4');           // the D-pad press, in effect
  await sleep(800);         // well past the threshold
  release('Enter', 13);
  await sleep(200);
  check('K4 moving off the card cancels the hold', NO_OVERLAY(), overlayState());

  // ── Focus is trapped in the menu ─────────────────────────
  focusCard('2');
  await holdEnter(900);
  await sleep(250);
  // The menu deliberately holds off taking focus until the opening press is
  // over, so this waits rather than sampling at a fixed delay.
  const took = await waitFor(inMenu);
  check('K5 the menu takes focus once the press is over',
    took && menuLabels().length > 0 && active()?.textContent.trim().startsWith('Play'),
    `focused: ${focusLabel()}, in menu: ${inMenu()}`);

  press('ArrowDown', 40);
  await sleep(150);
  check('K5 Down moves to the next row',
    inMenu() && active()?.textContent.trim().startsWith('Play all'),
    `focused: ${focusLabel()}, in menu: ${inMenu()}`);

  // Up from the first row must stay inside the menu rather than reaching the
  // grid behind it, that is what role="dialog" buys.
  press('ArrowUp', 38);
  await sleep(120);
  press('ArrowUp', 38);
  await sleep(150);
  check('K5 Up cannot escape the menu onto the grid', inMenu(),
    `focused: ${focusLabel()}`);

  press('Escape', 27);
  await sleep(300);
  check('K5 Back closes the menu and focus returns to the card',
    NO_OVERLAY() && active() === cardEl('2'),
    `${overlayState()}, active is card: ${active() === cardEl('2')}`);
}

// ── Play from here / Play all ───────────────────────────────
async function runMenu() {
  await sleep(900);
  await clearLogs();

  // ── Play from here, part-way into the loaded page ────────
  focusCard('5');
  press('Enter', 13);
  await sleep(900);
  release('Enter', 13);
  await sleep(250);

  press('ArrowDown', 40);      // Play all
  await sleep(120);
  press('ArrowDown', 40);      // Play from here
  await sleep(120);
  press('Enter', 13);
  await sleep(900);

  check('M1 Play from here opened the player', playerOpen(), playingTitle());
  check('M1 it starts on the scene that was long-pressed',
    playingScene() === 5, `playing scene ${playingScene()}`);

  // The queue is seeded, not refetched: page 1 was already loaded by the
  // grid, so choosing an action must not ask for anything.
  check('M1 no request was made to open the queue',
    (await requests()).length === 0, `${(await requests()).length} requests`);

  // ── Advancing walks the seeded listing ───────────────────
  // The player opens with the seek bar up, so these go through the ladder's two
  // stops (see stepNext/stepPrev); what is under test is the queue, not keys.
  mediaEl()?.pause();
  await stepNext();
  await sleep(300);
  check('M2 Down advances to the next scene in listing order',
    playingScene() === 6, `playing scene ${playingScene()}`);
  await stepNext();
  await sleep(300);
  check('M2 and again', playingScene() === 7, `playing scene ${playingScene()}`);
  await stepPrev();
  await sleep(300);
  check('M2 Up steps back', playingScene() === 6, `playing scene ${playingScene()}`);

  // ── Off the end of the loaded page, and on to the end of the listing ──
  // 40 rows are loaded; walking past them forces the queue to extend, and the
  // walk must stay contiguous, a gap drops scenes, a repeat re-fetches one.
  await clearLogs();
  // One press to return from the seek bar to the buttons; from there each ↓
  // is a step (the cursor stays on the rail through a step), so the 35
  // presses that follow walk scenes 6 → 41.
  press('ArrowDown', 40);
  await sleep(120);
  for (let id = 7; id <= 41; id++) {
    press('ArrowDown', 40);
    await sleep(60);
  }
  await sleep(900);
  const rows = await requests();
  const pages = rows.map(r => r.page);
  check('M3 stepping past the loaded page fetched the next one',
    pages.includes(2), `pages asked for: ${pages.join(', ') || 'none'}`);
  check('M3 no page was asked for twice',
    new Set(pages).size === pages.length, pages.join(', '));
  check('M3 the pages are contiguous from page 2',
    pages.every((p, i) => p === i + 2), pages.join(', '));
  check('M3 the cursor followed the extension',
    playingScene() === 41, `playing scene ${playingScene()}`);

  await sleep(500);

  // ── M3b: Back returns to the scene last viewed ───────────
  // The walk ended on scene 41, three pages in, while the grid still shows page
  // 1: the restored card must be scene 41 (not 5), and the grid must page to it.
  press('Backspace', 10009);
  await sleep(350);
  press('Backspace', 10009);
  const onLastCard = () => {
    const el = cardEl('41');
    return !!el && document.contains(el) && document.activeElement === el;
  };
  const restored = await waitFor(onLastCard, 8000, 50);
  check('M3 Back returns to the scene last viewed, not the one playback started on',
    restored, `focus ${focusLabel()}, card 41 present: ${!!cardEl('41')}`);
  check('M3 ...paging the grid forward to reach it',
    !!cardEl('41') && !!cardEl('40'),
    `card 40 ${!!cardEl('40')}, card 41 ${!!cardEl('41')}`);

  // ── M4: Back returns focus where the press came from ─────
  // Menu Play opens the player without the detail page, so nothing else records
  // a restore target and focus falls to <body>. Card 9 is not a stale target.
  focusCard('9');
  await holdEnter(900);
  await sleep(250);
  check('M4 setup: the menu is up on card 9', inMenu() && menuOpen(), overlayState());
  press('Enter', 13);          // Play, the first row, already focused
  await sleep(900);
  check('M4 setup: Play from the menu opened the player', playerOpen(), playingTitle());
  // The bar is up on open, so the first Back is the layering press, not the
  // close; both are asserted, or a single Back that closed the player would
  // leave the second check green.
  press('Backspace', 10009);
  await sleep(400);
  check('M4 the first Back on a menu-launched player hides the bar, not the player',
    playerOpen(), overlayState());
  press('Backspace', 10009);
  await sleep(600);
  check('M4 the next Back closes it', !playerOpen(), overlayState());
  check('M4 ...and focus is back on the card the menu was opened on',
    active() === cardEl('9'), `focus ${focusLabel()}`);
}

// ── Queue stops at the end of the listing ───────────────────
async function runQueue() {
  await sleep(900);
  await clearLogs();

  // Play all from the first card: the queue starts at scene 1 with only the
  // grid's first page behind it.
  focusCard('1');
  press('Enter', 13);
  await sleep(900);
  release('Enter', 13);
  await sleep(250);
  press('ArrowDown', 40);       // Play all
  await sleep(120);
  press('Enter', 13);
  await sleep(900);

  check('Q1 Play all starts at the top', playingScene() === 1, `playing scene ${playingScene()}`);
  mediaEl()?.pause();

  // Walk the whole thing. 100 scenes, so 99 steps, and the stop condition
  // is what has to hold on the last one.
  for (let i = 0; i < 101; i++) {
    press('ArrowDown', 40);
    await sleep(45);
  }
  await sleep(1200);

  const rows = await requests();
  const pages = rows.map(r => r.page);
  check('Q2 the walk reached the last scene',
    playingScene() === TOTAL, `playing scene ${playingScene()} of ${TOTAL}`);
  check('Q2 every page up to the last was fetched',
    pages.join(',') === '2,3', `pages: ${pages.join(',') || 'none'}`);
  check('Q2 nothing past the end was fetched',
    rows.every(r => r.page <= 3), `pages: ${pages.join(',')}`);

  // Pushing further must stay put rather than wrap or re-fetch.
  await clearLogs();
  for (let i = 0; i < 5; i++) {
    press('ArrowDown', 40);
    await sleep(60);
  }
  await sleep(600);
  check('Q2 further Downs past the end change nothing',
    playingScene() === TOTAL && (await requests()).length === 0,
    `scene ${playingScene()}, ${(await requests()).length} requests`);

  await closePlayer();
}

// ── The resume save ─────────────────────────────────────────
// Every advance re-points `src`, and a fresh src reports currentTime 0, so a
// teardown read says unwatched. Assert over all saves: the zero lands later.
async function runSaves() {
  await sleep(900);
  await clearLogs();

  const openPlayAll = async () => {
    focusCard('1');
    press('Enter', 13);
    await sleep(900);
    release('Enter', 13);
    await sleep(300);
    press('ArrowDown', 40);     // Play all
    await sleep(150);
    press('Enter', 13);
    await sleep(1200);
  };

  const savesFor = async (id) => (await saves()).filter(s => s.id === id);
  const worst = (rows) => rows.reduce((m, r) => Math.min(m, r.resume_time ?? 0), Infinity);

  await openPlayAll();

  const v = mediaEl();
  check('S1 the player is playing a real file',
    !!v && v.readyState >= 2, `readyState ${v?.readyState}, duration ${v?.duration}`);
  check('S1 it opened on the first scene', playingScene() === 1, `scene ${playingScene()}`);

  // ── Advance by hand, mid-scene ───────────────────────────
  // This is the control point. Down swaps the src out from under the outgoing
  // scene, so this is the save that a `v.currentTime` read gets wrong.
  v.currentTime = 25;
  await sleep(600);            // let a timeupdate carry 25 into the ref
  const at = v.currentTime;
  await stepNext();            // through the seek bar's stop, see stepNext
  await sleep(900);

  check('S2 Down advanced the queue', playingScene() === 2, `scene ${playingScene()}`);
  const one = await savesFor('1');
  check('S2 the outgoing scene was saved', one.length > 0, JSON.stringify(one));
  check('S2 nothing recorded it as unwatched',
    one.every(s => s.resume_time > 1),
    `saves for scene 1: ${JSON.stringify(one)} (it had reached ${at.toFixed(1)}s)`);
  check('S2 it recorded where it actually got to',
    Math.abs(worst(one) - at) < 5,
    `worst save ${worst(one)} vs the ${at.toFixed(1)}s it reached`);

  // ── Let the next one end on its own ──────────────────────
  // The other advance path: `ended` fires while the outgoing scene is still
  // loaded, so this save comes from a different moment than the teardown.
  const v2 = mediaEl();
  v2.currentTime = Math.max(1, (v2.duration || 60) - 1.5);
  await sleep(3000);

  check('S3 the queue advanced on its own', playingScene() === 3, `scene ${playingScene()}`);
  const two = await savesFor('2');
  check('S3 the finished scene was saved', two.length > 0, JSON.stringify(two));
  // A completed scene is meant to end on resume_time 0 (Stash's Continue
  // Watching is resume_time > 0), so only a zero *before* completion is wrong.
  // Deleting `completedRef`'s `? 0` turns this red.
  check('S3 mid-scene saves kept the position, then completion cleared it',
    two.length > 0
      && two.slice(0, -1).every(s => s.resume_time > 1)
      && two[two.length - 1].resume_time === 0,
    `saves for scene 2: ${JSON.stringify(two)}`);

  // ── Back, mid-scene ─────────────────────────────────────
  await clearLogs();
  const v3 = mediaEl();
  v3.currentTime = 20;
  await sleep(600);
  await closePlayer();

  const three = await savesFor('3');
  check('S3 closing mid-scene saves where it got to',
    three.length > 0 && three.every(s => s.resume_time > 15),
    `saves for scene 3: ${JSON.stringify(three)}`);

  // ── No stale scene may be saved on the way out ───────────
  const ids = [...new Set((await saves()).map(s => s.id))];
  check('S3 only the scene that was playing was saved when it closed',
    ids.length === 1 && ids[0] === '3', `saved ids this round: ${ids.join(', ')}`);

  // ── One write at a time; latest wins ─────────────────────
  // The server records each save then holds it 1.2 s (`save: slow`), so one row
  // while the first is in flight proves the client queued, not overlapped.
  await setMode({ save: 'slow' });
  await clearLogs();
  await openPlayAll();

  const v4 = mediaEl();
  v4.currentTime = 30;
  await sleep(600);
  v4.dispatchEvent(new Event('pause'));   // write A, held server-side
  await sleep(200);
  v4.currentTime = 45;
  await sleep(300);
  v4.dispatchEvent(new Event('pause'));   // queued: B, the later position
  await sleep(150);

  const inFlight = await saves();
  check('S4 a second save is queued while one is in flight',
    inFlight.length === 1, `saves while in flight: ${JSON.stringify(inFlight)}`);

  await sleep(2400);                       // A 1.2 s, then the queued B 1.2 s
  const drained = await savesFor('1');
  check('S4 the queued save lands after the first and carries the later position',
    drained.length === 2 && drained[1].resume_time > 40,
    `saves for scene 1: ${JSON.stringify(drained)}`);

  // ── A failed save keeps what is owed ─────────────────────
  // `play_duration` is cumulative, so dropping the owed time on a rejection
  // silently loses whatever was watched; the retry carries both halves.
  await setMode({ save: 'fail' });
  await clearLogs();
  await sleep(2500);                       // ~2.5 s of playback owed
  const v5 = mediaEl();
  v5.currentTime = 50;
  await sleep(400);
  v5.dispatchEvent(new Event('pause'));    // attempted, rejected
  await sleep(400);

  const rejected = await savesFor('1');
  check('S5 a rejected save is still attempted and recorded',
    rejected.length === 1, `saves for scene 1: ${JSON.stringify(rejected)}`);

  await setMode({ save: 'ok' });
  await sleep(500);                        // a little more playback owed
  v5.dispatchEvent(new Event('pause'));    // retry
  await sleep(700);

  const retried = await savesFor('1');
  check('S5 the retry carries the rejected attempt’s watch time too',
    retried.length === 2 && retried[1].playDuration >= retried[0].playDuration,
    `saves for scene 1: ${JSON.stringify(retried)}`);

  // ── A late response must not touch the new scene ─────────
  // The queue re-points at the incoming scene while the outgoing write is still
  // unacknowledged; a settling success must not stamp the live scene's state.
  await setMode({ save: 'slowlong' });     // 4 s, see server.py
  await clearLogs();
  const v6 = mediaEl();
  v6.currentTime = 50;
  await sleep(4500);                       // scene 1 owes ~4.5 s: more than
  v6.dispatchEvent(new Event('pause'));    // scene 2 can accrue while it waits
  await sleep(150);
  press('ArrowDown', 40);                  // advance while A is in flight

  // Scene 2 now plays for the rest of A's 4 s, so it has accrued more watch
  // time than scene 1's snapshot carries. A late success that drains the live
  // scene can then be seen: the correct build keeps all of it.
  await sleep(4200);
  const v7 = mediaEl();
  v7.currentTime = 5;
  await sleep(500);
  v7.dispatchEvent(new Event('pause'));    // scene 2's own save, queued
  await sleep(4000);                       // B settles; the queued save sends

  const incoming = await savesFor('2');
  check('S6 the new scene reports its own position',
    incoming.length > 0 && incoming.every(s => s.resume_time < 20),
    `saves for scene 2: ${JSON.stringify(incoming)}`);
  check('S6 the new scene keeps its own watch time',
    incoming.some(s => s.playDuration > 2),
    `saves for scene 2: ${JSON.stringify(incoming)}`);

  await setMode({ save: 'ok' });
}

// ── Auto-repeat on an ordinary button ───────────────────────
// Every plain button is a useFocusable too, and a held remote used to run its
// action at ~30 Hz; the stepper shows it: 7 stars + a 1 s hold lands on 10.
async function runButtons() {
  await sleep(900);

  focusCard('1');
  press('Enter', 13);
  await sleep(120);
  release('Enter', 13);
  await waitFor(detailOpen);
  check('B1 the detail page opened', detailOpen(), overlayState());

  const ratingLabel = () =>
    document.querySelector('[role="group"][aria-label^="Rating,"]')?.getAttribute('aria-label') || null;
  const rating = () => {
    const m = ratingLabel() && ratingLabel().match(/(\d+) of 10/);
    return m ? Number(m[1]) : null;
  };
  const plus = [...document.querySelectorAll(`${DETAIL} button`)]
    .find(b => b.getAttribute('aria-label') === 'Increase rating');

  check('B2 the rating stepper is on screen',
    !!plus && rating() === 7, `rating ${rating()}, + button ${!!plus}`);

  plus?.focus();
  await holdEnter(1000);
  await sleep(500);
  check('B3 a held OK advances a button once, not thirty times',
    rating() === 8,
    `rating group: ${ratingLabel() ?? '<not on screen>'} after a 1s hold (7 + 1 expected); `
    + `${overlayState()}; dialog text: ${(document.querySelector(DETAIL)?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)}`);

  // The control for this one is deleting the `if (e.repeat)` guard in
  // useFocusable, which puts the rating on 10.
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

// Home is the showroom since 0.15.0 with no paged grid; every runner drives
// `video-N` cards and a 100-scene listing on the Scenes tab, so switch once
// before the runner starts rather than retargeting ids (a shelf never pages).
//
// The settle matches filter-entry: Home's autoFocus timer runs after mount and
// pulls back a focus set before it fires.
async function goToScenes() {
  await waitFor(() => registry.has('nav-scenes'));
  await sleep(400);
  registry.get('nav-scenes')?.el.focus();
  await sleep(120);
  await press('Enter', 13);
  await release('Enter', 13);
  await waitFor(() => registry.has('video-1'), 6000);
  await sleep(300);
}

const RUNNERS = {
  keys: runKeys, menu: runMenu, queue: runQueue, saves: runSaves, buttons: runButtons,
};
const run = RUNNERS[VIEW] || runKeys;

goToScenes()
  .then(run)
  .then(async () => {
    check('view under test', true, VIEW);
    await finish();
  })
  .catch(async (e) => {
    results.push({
      name: 'HARNESS CRASHED',
      pass: false,
      detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
    });
    try { await finish(); } catch { /* nothing left to do */ }
  });
