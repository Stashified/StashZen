/**
 * Headless driver for the focus preview on VideoCard.
 *
 * Built around how the feature fails, not how it looks: the old bug faded the
 * cover out for a `<video>` that never painted a frame, leaving a near-black
 * tile. "It plays when it works" was never the untested half; "nothing is
 * hidden when it does not" is, and most of this file asserts that.
 *
 *   scene 2  preview served        → mounts, plays, becomes visible
 *   scene 3  preview 404s          → cover stays, nothing visible ever mounts
 *   scene 3  focused a second time → no second request (the failure is learned)
 *
 * Cover assertions use `getComputedStyle(...).opacity`, not class names:
 * CSS-module names are hashed, and opacity is what the user sees.
 */

import { createRoot } from 'react-dom/client';
import VideoGrid from '../../src/components/VideoGrid.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { useKeyHandler } from '../../src/hooks/useKeyHandler.js';
import { setSettings, getSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Mirrors in VideoCard. Duplicated so importing a shortened constant cannot
// keep the timing checks green.
const ARM_MS = 400;
const WATCHDOG_MS = 1200;
const SETTLE_MS = ARM_MS + WATCHDOG_MS + 600;

const CONTROLS = {
  mode: 'classic', sort: 'created_at', order: 'desc', cols: 4, filterId: null, search: '',
};

const clearLog = () => fetch('/clear', { method: 'POST' });
const previewFetches = () => fetch('/previewfetches').then(r => r.json());
const setMode = (patch) => fetch('/mode', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
});

// Cards carry no DOM id, so the focus registry is the only handle.
const focusCard = (id) => {
  const entry = registry.get(`video-${id}`);
  if (entry) entry.el.focus();
  return !!entry;
};

/** The card element for a scene id, or null. */
const cardEl = (id) => registry.get(`video-${id}`)?.el ?? null;
/** The card's cover, the <img> when the screenshot loaded, else the fallback. */
const coverEl = (id) => {
  const thumb = cardEl(id)?.querySelector('div');
  return thumb?.firstElementChild ?? null;
};
const videoEl = (id) => cardEl(id)?.querySelector('video') ?? null;
const opacityOf = (el) => (el ? parseFloat(getComputedStyle(el).opacity) : null);
/** A video is "on screen" only at full opacity, the design's whole contract. */
const videoVisible = (id) => opacityOf(videoEl(id)) === 1;
const countFetches = (rows, id) => rows.filter(r => String(r) === String(id)).length;

/**
 * Watch a card for `ms` and report whether a preview was ever *born* visible.
 *
 * A settled read misses this: the 404 lands in milliseconds, so a
 * mount-revealed video would be visible for one frame then unmounted, and a
 * later sample would pass on the bug. The verdict is taken at insertion,
 * before any transition, reading both the class (what the build chose) and
 * the opacity (what the user sees).
 */
async function watchFirstMount(id, ms) {
  const card = cardEl(id);
  let violation = null;
  const seen = [];
  const obs = new MutationObserver(() => {
    const v = videoEl(id);
    if (!v) return;
    const classed = v.className.includes('previewVisible');
    const op = parseFloat(getComputedStyle(v).opacity);
    seen.push(op);
    if (!violation && (classed || op === 1)) {
      violation = classed
        ? 'mounted already carrying the visible class'
        : `mounted at opacity ${op}`;
    }
  });
  if (card) obs.observe(card, { childList: true, subtree: true, attributes: true });
  await sleep(ms);
  obs.disconnect();
  return { violation, seen };
}

function Harness() {
  // Spatial nav and the `is-navigating` body class both come from here; the
  // guard check depends on the class.
  useKeyHandler({ onBack: () => {} });
  return (
    <VideoGrid
      controls={CONTROLS}
      objectFilter={null}
      searchQuery=""
      onVideoSelect={() => {}}
    />
  );
}

async function run() {
  // ── P0: a fresh install has previews on ─────────────────────
  // Read before anything writes the setting: a new profile takes the
  // module-init path a first launch does. P1 tests the off branch explicitly,
  // which would hide a default flipped back, so the default needs its own
  // check.
  check('P0 a fresh install has focus previews on',
    getSettings().previewsEnabled === true,
    `previewsEnabled=${getSettings().previewsEnabled}`);

  // ── P1: off explicitly means nothing is asked for ────────────
  // The feature's risk is doing what the user did not ask for, so the switch
  // must work independently of the default.
  setSettings({ previewsEnabled: false });
  // The grid autofocuses card 1 on mount and can request under the default;
  // let the switch take effect, then reset the counter.
  await sleep(200);
  await clearLog();
  focusCard(1);
  await sleep(SETTLE_MS);
  const fetchesOff = await previewFetches();
  check('P1 previews off: no <video> is mounted at all',
    document.querySelectorAll('video').length === 0,
    `found ${document.querySelectorAll('video').length}`);
  check('P1 previews off: not one preview is requested',
    fetchesOff.length === 0, `fetches=[${fetchesOff.join(',')}]`);

  // ── P2: served preview → mounts, plays, shows ────────────────
  await setMode({ preview: 'ok' });
  await clearLog();
  setSettings({ previewsEnabled: true });
  focusCard(2);
  await sleep(SETTLE_MS);

  const v2 = videoEl(2);
  check('P2 preview available: the card mounts its own scene\'s preview',
    !!v2 && (v2.getAttribute('src') || '').includes('/scene/2/preview'),
    v2 ? `src=${v2.getAttribute('src')}` : 'no <video>');
  check('P2 preview available: it becomes visible once it plays',
    videoVisible(2), `opacity=${opacityOf(v2)}`);
  check('P2 preview available: the cover is still rendered underneath',
    !!coverEl(2) && opacityOf(coverEl(2)) === 1,
    `cover=${coverEl(2)?.tagName} opacity=${opacityOf(coverEl(2))}`);
  // Still playing after the no-frame watchdog would have fired: one that did
  // not stand down once a preview arrived would withdraw after about a
  // second, invisible to every check above.
  await sleep(WATCHDOG_MS + 400);
  check('P2 preview available: it is still playing past the no-frame watchdog',
    videoVisible(2), `opacity=${opacityOf(videoEl(2))}${videoEl(2) ? '' : ' (unmounted)'}`);

  // ── P3: absent preview → the cover stays, nothing is shown ───
  await setMode({ preview: 'missing' });
  await clearLog();
  // Started before focus lands, so the preview's first frame is observed.
  const watched = watchFirstMount(3, SETTLE_MS);
  focusCard(3);
  const { violation, seen } = await watched;

  check('P3 preview absent: the cover is still on screen',
    !!coverEl(3) && opacityOf(coverEl(3)) === 1,
    `cover=${coverEl(3)?.tagName} opacity=${opacityOf(coverEl(3))}`);
  check('P3 preview absent: it is never revealed, not even for a frame',
    !violation, violation || `opacities seen: [${seen.join(', ')}]`);
  check('P3 preview absent: nothing is left visible over the cover',
    !videoVisible(3),
    videoEl(3) ? `stray <video> at opacity=${opacityOf(videoEl(3))}` : 'no <video> left mounted');

  // ── P4: the failure is remembered ────────────────────────────
  // Without this a 404 is re-requested once per navigation over the card.
  const before = await previewFetches();
  focusCard(4);
  await sleep(300);
  focusCard(3);
  await sleep(SETTLE_MS);
  const after = await previewFetches();
  check('P4 a scene that failed is not asked for again',
    countFetches(before, 3) === countFetches(after, 3),
    `scene 3 fetches: ${countFetches(before, 3)} → ${countFetches(after, 3)}`);
  check('P4 a scene that failed mounts no preview on the second pass',
    !videoEl(3), videoEl(3) ? 'a <video> was mounted again' : 'none');

  // ── P5: the resting-guard ────────────────────────────────────
  // `is-navigating` is the app's signal for a held arrow crossing several
  // cards a second; no card may fetch while it is set.
  await setMode({ preview: 'ok' });
  await clearLog();
  document.body.classList.add('is-navigating');
  focusCard(5);
  await sleep(SETTLE_MS);
  const during = await previewFetches();
  check('P5 while the D-pad is held, no preview is requested',
    !during.includes('5'), `fetches=[${during.join(',')}]`);
  check('P5 while the D-pad is held, no preview is mounted',
    !videoEl(5), videoEl(5) ? 'a <video> was mounted mid-navigation' : 'none');

  // The class does the work, not the delay: cleared, with focus unmoved, the
  // preview arrives.
  document.body.classList.remove('is-navigating');
  await sleep(SETTLE_MS);
  check('P5 once it is released, the same card previews without a refocus',
    videoVisible(5), `opacity=${opacityOf(videoEl(5))}`);

  // ── P6: Reduce motion keeps previews paused ─────────────────
  // The switch is broader than P1's: previews stay enabled and the cards must
  // still not play. Turning it off again must bring the preview back, or the
  // setting would be a one-way door.
  await setMode({ preview: 'ok' });
  setSettings({ reduceMotion: true });
  await sleep(200);
  await clearLog();
  focusCard(6);
  await sleep(SETTLE_MS);
  const stillFetches = await previewFetches();
  check('P6 reduce motion mounts no preview and asks for none',
    !videoEl(6) && countFetches(stillFetches, 6) === 0,
    `video=${!!videoEl(6)} fetches=[${stillFetches.join(',')}]`);

  setSettings({ reduceMotion: false });
  await sleep(SETTLE_MS);
  check('P6 turning it back off lets the same card preview again',
    videoVisible(6), `opacity=${opacityOf(videoEl(6))}`);

  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

// Point the real service layer at the fake endpoint. Set before the first
// render: `useSettings` snapshots module state as its initial value.
setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(document.getElementById('root')).render(<Harness />);
sleep(1200).then(run).catch(async (e) => {
  check('driver completed', false, String(e && e.stack || e));
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  }).catch(() => {});
  await fetch('/done', { method: 'POST' }).catch(() => {});
});
