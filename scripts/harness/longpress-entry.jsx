/**
 * Headless driver for the long-press menus on Markers, Images and Galleries,
 * and for the slideshow the viewer's menu entries open.
 *
 * Mounts the real App: all of this is wiring, which card hands its listing to
 * which menu, where the queue's first timestamp comes from, and which card
 * focus returns to when an overlay closes. A driver re-creating those handlers
 * would test a copy.
 *
 * The endpoint is fake (scripts/harness/server.py); everything else is shipped
 * code. One runner, three sections, in the TV rail's order.
 *
 * Fixture:
 * - Marker `seconds` sit inside the 60 s tone every scene streams, so "started
 *   at the marker" is a real seek rather than a clamp to duration.
 * - A gallery's pictures are served only under `/mode galleryImages=populate`;
 *   the default gallery-filtered image listing is empty for Sections S6, so
 *   this driver asks for the populated answer.
 * - Markers each belong to a distinct scene. Dedupe of two markers on one scene
 *   belongs to test-play-queue.mjs; this driver sees that the player walks
 *   scenes rather than markers: Play all starts on scene 1 and Down reaches 2.
 *
 * The slideshow's 6 s timer is a real wait, twice: the cadence is the feature.
 */

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

const active = () => document.activeElement;

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

// ↓ is a two-stop ladder: with the seek bar up and no cursor on it, the first
// press returns to the buttons and only the second steps. The player opens with
// the bar up, so a queue step needs both. Blurring afterwards restores the
// starting state.
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

/** Hold Enter the way a remote does, then let go. Crosses the 600 ms long press. */
async function holdEnter(ms = 950) {
  press('Enter', 13);
  await sleep(ms);
  release('Enter', 13);
}

async function waitFor(pred, ms = 2000, step = 25) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

/** The async form: poll a fetch-backed getter until its rows satisfy `pred`. */
async function waitForFetch(getter, pred, ms = 3000) {
  const end = performance.now() + ms;
  let rows = [];
  while (performance.now() < end) {
    rows = await getter();
    if (pred(rows)) return rows;
    await sleep(50);
  }
  return rows;
}

const setMode = (patch) => fetch('/mode', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
}).then(r => r.json());
const requests = () => fetch('/requests').then(r => r.json());
const imageInfoFetches = () => fetch('/imageinfofetches').then(r => r.json());
const clearLogs = () => fetch('/clear', { method: 'POST' });

const focusId = (id) => {
  const el = registry.get(id)?.el;
  el?.focus();
  return !!el;
};

// Every overlay is a `role="dialog"`, but the player is not modal, VideoPlayer
// uses the role for its focus trap, not a backdrop. Querying only aria-modal
// dialogs hid the player and made every title assertion read "".
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const isMenu = (d) => (d.getAttribute('aria-label') || '').startsWith('Actions for');
const menuEl = () => dialogs().find(isMenu) || null;
const viewerEl = () => dialogs().find(d => d.getAttribute('aria-modal') === 'true'
  && !isMenu(d)) || null;
const playerEl = () => dialogs().find(d =>
  (d.getAttribute('aria-label') || '').startsWith('Now playing')) || null;

const menuOpen = () => !!menuEl();
const viewerOpen = () => !!viewerEl();

const menuLabels = () =>
  [...(menuEl()?.querySelectorAll('button') || [])]
    .map(b => b.firstElementChild?.textContent.trim());
const menuHints = () =>
  [...(menuEl()?.querySelectorAll('button') || [])]
    .map(b => b.children[1]?.textContent.trim() || null);
const menuSubtitle = () => menuEl()?.querySelector('header p')?.textContent || null;

const viewerTitle = () => viewerEl()?.querySelector('h2')?.textContent || null;
const viewerCounter = () => {
  const text = viewerEl()?.querySelector('footer span')?.textContent || '';
  const m = text.match(/(\d+)\s*of\s*(\d+)\s*loaded/);
  return m ? Number(m[1]) : null;
};
// The label flips between Slideshow and Stop slideshow, so read the button's
// own state by id, not by the text that named it a second ago.
const viewerPlaying = () =>
  registry.get('image-viewer-play')?.el?.getAttribute('aria-pressed') === 'true';

const infoPanel = () => viewerEl()?.querySelector('[aria-label="Image info"]') || null;
// The stage's <img>; the info panel holds none, so the viewer's first image is
// the picture under test.
const viewerImageSrc = () => viewerEl()?.querySelector('img')?.getAttribute('src') || null;

const playingTitle = () => playerEl()?.querySelector('h2')?.textContent || '';
const mediaEl = () => document.querySelector('video');

/**
 * Open a long-press menu on a card by holding Enter on it.
 * Returns once the menu is on screen, so every caller can assert its rows.
 */
async function openMenuOn(id) {
  if (!focusId(id)) throw new Error(`no focus entry for ${id}`);
  await sleep(120);
  await holdEnter();
  await sleep(250);
  return waitFor(menuOpen, 1500);
}

/** Activate a menu row by its registry id. Rows have no long press. */
async function chooseMenuRow(id) {
  const el = registry.get(id)?.el;
  if (!el) throw new Error(`no menu row ${id}`);
  el.focus();
  await sleep(80);
  press('Enter', 13);
  await sleep(120);
  release('Enter', 13);
}

/**
 * Close the player in however many Backs it actually needs.
 *
 * The first Back only hides the control bar when it is up, and it auto-hides
 * during this driver's long waits; a fixed two-press close then hits the app
 * underneath and raises the exit prompt. Press until the player is gone, which
 * also keeps focus on the card rather than on Cancel.
 */
async function closePlayer() {
  for (let i = 0; i < 3 && playerEl(); i++) {
    press('Backspace', 10009);
    await sleep(450);
  }
  await waitFor(() => !playerEl(), 1500);
  await sleep(250);
}

async function goToTab(tab, readyId) {
  if (!focusId(`nav-${tab}`)) throw new Error(`no nav-${tab}`);
  await sleep(100);
  press('Enter', 13);
  await sleep(80);
  release('Enter', 13);
  // Home's autoFocus timer: a focus set before it fires gets pulled back.
  await sleep(300);
  return waitFor(() => registry.has(readyId), 6000);
}

const railActive = () =>
  [...(document.querySelector('nav[aria-label="Main navigation"]')?.querySelectorAll('button') ?? [])]
    .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || '(none)';

// ── Markers ─────────────────────────────────────────────────
async function runMarkers() {
  await goToTab('markers', 'marker-1');

  const opened = await openMenuOn('marker-1');
  check('M1 holding OK on a marker opens its menu', opened && menuOpen(),
    `menu ${menuOpen()}, focus ${active()?.tagName}`);
  check('M1 the rows are Play / Play all / Play from here / Edit marker / Delete marker / Details',
    JSON.stringify(menuLabels()) === JSON.stringify([
      'Play', 'Play all', 'Play from here', 'Edit marker', 'Delete marker', 'Details',
    ]),
    `rows ${JSON.stringify(menuLabels())}`);
  check('M1 the subtitle names the timestamp and the parent scene',
    menuSubtitle() === 'at 0:06 in VERIFY scene 1',
    `subtitle "${menuSubtitle()}"`);
  check('M1 the Play hint carries the marker time',
    menuHints()[0] === '0:06', `hint "${menuHints()[0]}"`);
  check('M1 Play from here counts the distinct scenes from this marker on',
    menuHints()[2] === '40+ scenes', `hint "${menuHints()[2]}"`);

  // ── Play: the marker's own scene, at the marker's timestamp ──
  await chooseMenuRow('menu-play');
  await waitFor(() => !!playerEl() && !!mediaEl(), 3000);
  const v1 = mediaEl();
  const sought = await waitFor(() => v1 && v1.currentTime >= 5, 4000);
  check('M2 Play opens the scene the marker belongs to',
    playingTitle() === 'VERIFY scene 1: VERIFY marker 1', `playing "${playingTitle()}"`);
  check('M2 ...and starts at the marker, not at zero',
    sought, `currentTime ${v1?.currentTime?.toFixed(1)}s after 4 s (marker at 0:06)`);
  await closePlayer();
  check('M2 closing the player returns focus to the marker card',
    active() === registry.get('marker-1')?.el,
    `focus ${active()?.tagName} ${active()?.textContent?.trim().slice(0, 30)}`);

  // ── Play all: a scene queue, one scene per marker ─────────────
  await openMenuOn('marker-1');
  await chooseMenuRow('menu-play-all');
  await waitFor(() => !!mediaEl(), 3000);
  const v2 = mediaEl();
  const allStarted = await waitFor(() => v2 && v2.currentTime >= 5, 4000);
  check('M3 Play all starts on the first marker\'s scene, at its time',
    playingTitle() === 'VERIFY scene 1: VERIFY marker 1' && allStarted,
    `playing "${playingTitle()}" at ${v2?.currentTime?.toFixed(1)}s`);

  await stepNext();
  await waitFor(() => /VERIFY scene 2\b/.test(playingTitle()), 3000);
  await sleep(700);
  check('M3 Down walks to the next scene, not the next marker row',
    playingTitle() === 'VERIFY scene 2: VERIFY marker 2', `playing "${playingTitle()}"`);
  check('M3 ...and a non-starting scene opens at zero',
    (mediaEl()?.currentTime ?? 99) < 3,
    `currentTime ${mediaEl()?.currentTime?.toFixed(1)}s on scene 2`);
  await closePlayer();
  // Back returns to the marker of the scene last viewed, scene 2, marker 2:
  // not the one the queue started from. A marker queue plays scenes, so the
  // scene id names no card here; the row's `markerId` is what the restore reads.
  check('M3 closing the player returns to the marker of the scene last viewed',
    active() === registry.get('marker-2')?.el,
    `focus ${active()?.tagName} ${active()?.textContent?.trim().slice(0, 30)}`);

  // ── Play from here: starts at the pressed marker ─────────────
  await openMenuOn('marker-3');
  check('M4 Play from here on marker 3 counts the scenes after it',
    menuHints()[2] === '38+ scenes', `hint "${menuHints()[2]}"`);
  await chooseMenuRow('menu-play-here');
  await waitFor(() => !!mediaEl(), 3000);
  const v3 = mediaEl();
  const hereSought = await waitFor(() => v3 && v3.currentTime >= 7, 4000);
  check('M4 Play from here opens the marker it was invoked from',
    playingTitle() === 'VERIFY scene 3: VERIFY marker 3' && hereSought,
    `playing "${playingTitle()}" at ${v3?.currentTime?.toFixed(1)}s (marker at 0:08)`);
  await closePlayer();

  // ── Back closes the menu and returns to the card ─────────────
  await openMenuOn('marker-1');
  press('Backspace', 10009);
  await waitFor(() => !menuOpen(), 1500);
  await sleep(250);
  check('M5 Back closes the menu and restores the marker card',
    !menuOpen() && active() === registry.get('marker-1')?.el,
    `menu ${menuOpen()}, focus ${active()?.tagName}`);
}

// ── Images ──────────────────────────────────────────────────
async function runImages() {
  await goToTab('images', 'image-1');

  await openMenuOn('image-1');
  check('I1 holding OK on an image opens its menu',
    menuOpen()
      && JSON.stringify(menuLabels())
        === JSON.stringify(['View', 'Slideshow from here', 'Slideshow from start', 'Info']),
    `rows ${JSON.stringify(menuLabels())}`);
  check('I1 the subtitle reports the position in the listing',
    menuSubtitle() === '1 of 100 in this listing', `subtitle "${menuSubtitle()}"`);

  // ── Info opens the viewer with the panel already up ─────────
  await chooseMenuRow('menu-image-info');
  await waitFor(() => viewerOpen() && viewerTitle() === 'VERIFY image 1', 4000);
  check('I2 Info opens the viewer on the pressed image',
    viewerTitle() === 'VERIFY image 1', `viewer "${viewerTitle()}"`);
  check('I2 ...with the info panel already open', !!infoPanel(),
    `panel ${!!infoPanel()}`);
  const infoRows = await waitForFetch(imageInfoFetches, r => r.length > 0);
  check('I2 the panel asked the server about that image',
    infoRows.some(r => String(r.id) === '1'),
    `fetches ${JSON.stringify(infoRows.map(r => r.id))}`);
  const painted = await waitFor(
    () => /VERIFY image studio 1/.test(infoPanel()?.textContent || ''), 3000);
  check('I2 ...and painted that image\'s answer', painted,
    `panel text "${(infoPanel()?.textContent || '').replace(/\s+/g, ' ').slice(0, 80)}"`);

  press('Backspace', 10009);
  await sleep(300);
  check('I2 the first Back closes the panel, not the viewer',
    viewerOpen() && !infoPanel(), `viewer ${viewerOpen()}, panel ${!!infoPanel()}`);
  press('Backspace', 10009);
  await waitFor(() => !viewerOpen(), 1500);
  await sleep(250);
  check('I2 the second Back returns focus to the image card',
    !viewerOpen() && active() === registry.get('image-1')?.el,
    `viewer ${viewerOpen()}, focus ${active()?.tagName}`);

  // ── Slideshow: advance on the timer, stop on a manual step ──
  await openMenuOn('image-2');
  await chooseMenuRow('menu-image-slideshow-start');
  await waitFor(() => viewerOpen() && viewerPlaying(), 4000);
  check('I3 Slideshow from start opens on image 1, already playing',
    viewerTitle() === 'VERIFY image 1' && viewerPlaying(),
    `viewer "${viewerTitle()}", buttons ${[...(viewerEl()?.querySelectorAll('header button') || [])].map(b => b.textContent.trim())}`);

  // Press Left in the same microtask as the advance's DOM commit, not a task
  // later. The key listener re-registers for the new index every step, and
  // with a passive effect that lands a task after the commit; a press in
  // between runs the previous closure (index 0, `canPrev` false) and is
  // silently ignored. A MutationObserver callback runs after the commit and
  // layout effects but before the passive effect's task, making this press
  // deterministic and the red control real.
  let focusWasSurface = false;
  const advanced = await new Promise((resolve) => {
    const viewer = viewerEl();
    const obs = new MutationObserver(() => {
      if (viewerTitle() !== 'VERIFY image 2') return;
      obs.disconnect();
      // The arrows are the viewer's only while the surface holds focus;
      // record that at press time.
      focusWasSurface = active() === viewerEl();
      press('ArrowLeft', 37);
      resolve(true);
    });
    obs.observe(viewer, { subtree: true, childList: true, characterData: true });
    setTimeout(() => { obs.disconnect(); resolve(false); }, 9000);
  });
  check('I3 the slideshow advances by itself after the 6 s beat', advanced,
    `viewer "${viewerTitle()}"`);
  check('I3 ...and the surface still holds focus',
    focusWasSurface, `focus ${active()?.tagName} ${active()?.getAttribute?.('aria-label') || active()?.textContent?.trim().slice(0, 30)}`);

  await sleep(350);
  check('I3 a manual step goes back one', viewerTitle() === 'VERIFY image 1',
    `viewer "${viewerTitle()}"`);
  check('I3 ...and stops the slideshow', !viewerPlaying(),
    `buttons ${[...(viewerEl()?.querySelectorAll('header button') || [])].map(b => b.textContent.trim())}`);
  await sleep(6800);
  check('I3 ...so it does not advance past the next beat', viewerTitle() === 'VERIFY image 1',
    `viewer "${viewerTitle()}" after 6.8 s stopped`);

  press('Backspace', 10009);
  await waitFor(() => !viewerOpen(), 1500);
  await sleep(250);
  // The menu opened on image 2, but a manual step left the viewer on image 1;
  // "the picture you were looking at" beats "the card you started from".
  check('I3 closing the viewer returns focus to the image last viewed',
    active() === registry.get('image-1')?.el,
    `focus ${active()?.tagName} ${(active()?.textContent || '').trim().slice(0, 30)}`);
}

// ── Galleries ───────────────────────────────────────────────
async function runGalleries() {
  await setMode({ galleryImages: 'populate' });
  await goToTab('galleries', 'gallery-2');

  await clearLogs();
  await openMenuOn('gallery-2');
  check('G1 holding OK on a gallery opens its menu',
    menuOpen()
      && JSON.stringify(menuLabels())
        === JSON.stringify(['View images', 'Slideshow', 'Shuffle slideshow']),
    `rows ${JSON.stringify(menuLabels())}`);
  check('G1 the subtitle is the gallery\'s picture count',
    menuSubtitle() === '8 images', `subtitle "${menuSubtitle()}"`);

  // ── Slideshow: fetch this gallery's pictures, then run ──────
  await chooseMenuRow('menu-gallery-slideshow');
  await waitFor(() => viewerOpen() && viewerTitle() === 'VERIFY gallery 2', 5000);
  check('G2 Slideshow opens the viewer on the gallery',
    viewerTitle() === 'VERIFY gallery 2', `viewer "${viewerTitle()}"`);
  const firstPage = await waitFor(() => viewerCounter() === 1, 4000);
  check('G2 ...with the gallery\'s own first picture loaded',
    firstPage && /\/image\/6021\/full\.png/.test(viewerImageSrc() || ''),
    `counter ${viewerCounter()}, picture ${viewerImageSrc()}`);
  const galReqs = (await requests()).filter(r => r.image_filter?.galleries);
  check('G2 the pictures were fetched with a gallery criterion',
    galReqs.some(r => r.image_filter.galleries.value?.[0] === '2'),
    `${galReqs.length} filtered image listing(s), last ${JSON.stringify(galReqs.at(-1)?.image_filter ?? null)}`);
  check('G2 ...and the slideshow is running',
    viewerPlaying(), `buttons ${[...(viewerEl()?.querySelectorAll('header button') || [])].map(b => b.textContent.trim())}`);

  const galleryAdvanced = await waitFor(() => viewerCounter() === 2, 8000);
  check('G2 the gallery slideshow advances by itself', galleryAdvanced,
    `counter ${viewerCounter()}`);
  check('G2 the second picture is the gallery\'s second',
    /\/image\/6022\/full\.png/.test(viewerImageSrc() || ''),
    `picture ${viewerImageSrc()}`);

  press('Backspace', 10009);
  await waitFor(() => !viewerOpen(), 1500);
  await sleep(250);
  check('G2 Back returns focus to the gallery card',
    active() === registry.get('gallery-2')?.el,
    `focus ${active()?.tagName} ${(active()?.textContent || '').trim().slice(0, 30)}`);

  // ── Shuffle: the same fetch, a different entry, from another gallery ──
  await openMenuOn('gallery-3');
  await chooseMenuRow('menu-gallery-shuffle');
  await waitFor(() => viewerOpen() && viewerTitle() === 'VERIFY gallery 3', 5000);
  const shuffled = await waitFor(() => viewerCounter() === 1, 4000);
  check('G3 Shuffle slideshow opens gallery 3\'s own pictures',
    shuffled && /\/image\/603\d\/full\.png/.test(viewerImageSrc() || ''),
    `counter ${viewerCounter()}, picture ${viewerImageSrc()}`);
  press('Backspace', 10009);
  await waitFor(() => !viewerOpen(), 1500);

  // ── View images: the same destination as Enter ──────────────
  await openMenuOn('gallery-4');
  await chooseMenuRow('menu-gallery-view');
  await sleep(600);
  check('G4 View images leaves for the Images tab, filtered to the gallery',
    !menuOpen() && !viewerOpen() && railActive() === 'Images',
    `menu ${menuOpen()}, viewer ${viewerOpen()}, rail "${railActive()}"`);
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

setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(root).render(<App />);

// The marker listing must cross a page boundary for "40+ scenes" and for the
// queue to walk past the loaded page; the default fixture is markerfix's two
// rows. See FindSceneMarkers in server.py.
setMode({ markers: 'paged' })
  .then(runMarkers)
  .then(runImages)
  .then(runGalleries)
  .then(async () => {
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
