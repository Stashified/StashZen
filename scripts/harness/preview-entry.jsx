/**
 * Headless driver for the focus preview on VideoCard.
 *
 * The preview is a feature this card has already had once and lost, so the
 * checks here are built around the way it failed rather than around the way it
 * is supposed to look. What went wrong in 0.2.4 was that the cover was faded
 * out and a `<video>` put in its place, and the video never painted a frame —
 * so the card sat on a near-black tile. "It plays when it works" was never the
 * untested half. **"Nothing is hidden when it does not" is**, and that is what
 * most of this file asserts.
 *
 * The three states that matter, and the scene each one uses:
 *
 *   scene 2  preview served        → mounts, plays, becomes visible
 *   scene 3  preview 404s          → cover stays, nothing visible ever mounts
 *   scene 3  focused a second time → no second request (the failure is learned)
 *
 * The cover assertion is deliberately on `getComputedStyle(...).opacity` rather
 * than on a class name: CSS-module class names are hashed, and opacity is what
 * the user actually sees.
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

// Mirrors in VideoCard. Duplicated rather than imported: a driver that read the
// component's own constants would keep passing if someone shortened them to
// zero, which is exactly the change the timing checks exist to catch.
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

// Focus a card by asking the real focus registry where it is. The cards carry
// no DOM id, so this is the only handle on them.
const focusCard = (id) => {
  const entry = registry.get(`video-${id}`);
  if (entry) entry.el.focus();
  return !!entry;
};

/** The card element for a scene id, or null. */
const cardEl = (id) => registry.get(`video-${id}`)?.el ?? null;
/** The card's cover — the <img> when the screenshot loaded, else the fallback. */
const coverEl = (id) => {
  const thumb = cardEl(id)?.querySelector('div');
  return thumb?.firstElementChild ?? null;
};
const videoEl = (id) => cardEl(id)?.querySelector('video') ?? null;
const opacityOf = (el) => (el ? parseFloat(getComputedStyle(el).opacity) : null);
/** A video is "on screen" only at full opacity — the design's whole contract. */
const videoVisible = (id) => opacityOf(videoEl(id)) === 1;
const countFetches = (rows, id) => rows.filter(r => String(r) === String(id)).length;

/**
 * Watch a card for `ms` and report whether a preview was ever *born* visible.
 *
 * A settled read cannot see the failure this exists for. "The cover was hidden
 * before the preview proved itself" is a transient: the 404 here lands in
 * milliseconds, so a build that revealed the video on mount would be fully
 * visible for one frame and then unmounted — and a check that samples once,
 * afterwards, would report a clean pass on exactly the v0.2.4 bug.
 *
 * The verdict is taken at the moment of insertion, before any transition can
 * run, and on the class the render actually decided on rather than on a
 * sampled opacity: right after insertion there is no previous computed value
 * for the transition to interpolate from, so a mount-revealed video jumps
 * straight to 1 rather than fading. Reading both is deliberate — the class
 * says what the build chose, the opacity says what the user would see.
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
  // Required, not decorative: spatial nav and the `is-navigating` body class
  // both come from this hook, and the guard check below depends on the class.
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
  // Read before anything writes the setting. The profile is new, so this is
  // the module-init path a first launch takes. P1 sets the switch off
  // explicitly, which is how the off branch is tested — that would hide a
  // default quietly flipped back, so the default needs its own check.
  check('P0 a fresh install has focus previews on',
    getSettings().previewsEnabled === true,
    `previewsEnabled=${getSettings().previewsEnabled}`);

  // ── P1: off explicitly means nothing is asked for ────────────
  // The feature's whole risk profile is "it does something the user did not
  // ask for", so the switch has to work on its own, independent of the default.
  setSettings({ previewsEnabled: false });
  // The grid autofocuses card 1 on mount, and with previews on by default
  // that can start a request before this line runs. Let the switch take
  // effect, then reset the counter: P1 is about what the *off* state asks
  // for, not about a request made under the default.
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
  // …and still there after the no-frame watchdog would have fired. The
  // watchdog exists to give up on a preview that never arrives; a version that
  // did not stand down once one *had* arrived would play for about a second and
  // then withdraw, which is a worse bug than not previewing at all and is
  // invisible to every check above.
  await sleep(WATCHDOG_MS + 400);
  check('P2 preview available: it is still playing past the no-frame watchdog',
    videoVisible(2), `opacity=${opacityOf(videoEl(2))}${videoEl(2) ? '' : ' (unmounted)'}`);

  // ── P3: absent preview → the cover stays, nothing is shown ───
  await setMode({ preview: 'missing' });
  await clearLog();
  // Sampled from before the focus lands, so the very first frame the preview
  // exists for is one of the frames observed.
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
  // Without this the card re-requests a 404 every time the user passes over it,
  // which on a grid is once per navigation.
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
  // A held arrow crosses several cards a second. `is-navigating` is the app's
  // own signal for that, and a card must not start a fetch while it is set.
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

  // …and that it is the class doing the work, not merely the delay: with the
  // class cleared and focus unmoved, the preview arrives.
  document.body.classList.remove('is-navigating');
  await sleep(SETTLE_MS);
  check('P5 once it is released, the same card previews without a refocus',
    videoVisible(5), `opacity=${opacityOf(videoEl(5))}`);

  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

// The grid fetches through the real service layer, so it has to be pointed at
// the fake endpoint on this origin — same as every other driver here. Set
// before the first render: `useSettings` snapshots the module state as its
// initial value.
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
