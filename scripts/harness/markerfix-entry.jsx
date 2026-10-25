/**
 * Headless driver for the marker grid's screenshot source.
 *
 * Stash answers an ungenerated marker screenshot with a 200 "Pending
 * Generate" placeholder, not a 404, so the `normalizeMarker` fallback
 * (`m.screenshot || m.scene.paths.screenshot`, marker frame first) never fell
 * through: every tile showed one identical stub while the parent scene's real
 * 1920x1080 frame went unused. `server.py` therefore serves covers coloured by
 * scene id and one fixed placeholder per marker frame.
 *
 * "An image loaded" and "the src is a URL" both pass on the broken build; the
 * observable is that different markers show different bytes.
 */

import { createRoot } from 'react-dom/client';
import MarkerGrid from '../../src/components/MarkerGrid.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { useKeyHandler } from '../../src/hooks/useKeyHandler.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The two markers the fake serves, and the scene each belongs to.
const MARKERS = [
  { id: '9001', sceneId: '1' },
  { id: '9002', sceneId: '2' },
];

const CONTROLS = {
  mode: 'classic', sort: 'created_at', order: 'desc', cols: 4, filterId: null, search: '',
};

/**
 * Fetch a list of URLs and keep every body as a Uint8Array.
 *
 * Bodies, not lengths: the images are all the same size, so length would
 * measure the wrong thing.
 */
const fetchBytes = (urls) => Promise.all(urls.map(url =>
  fetch(url).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)).catch(() => new Uint8Array())));

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A short, stable fingerprint, so a failure report shows *which* two images. */
const digestOf = (b) => {
  let h = 2166136261;
  for (const x of b) h = Math.imul(h ^ x, 16777619) >>> 0;
  return `${b.length}b/${h.toString(16).padStart(8, '0')}`;
};

/** The <img> inside a marker card, or null if it fell back to the letter tile. */
const shotEl = (id) => {
  const card = registry.get(`marker-${id}`)?.el;
  return card?.querySelector('img') ?? null;
};
const shotSrc = (id) => shotEl(id)?.getAttribute('src') ?? null;

function Harness() {
  // Supplies spatial nav and the grid's key handling; without it the page
  // never renders a usable tree.
  useKeyHandler({ onBack: () => {} });
  return (
    <MarkerGrid
      controls={CONTROLS}
      objectFilter={null}
      searchQuery=""
      onMarkerSelect={() => {}}
    />
  );
}

async function run() {
  // Wait for the grid to leave its loading state: the fetch goes through the
  // real service layer and list cache.
  for (let i = 0; i < 40 && !registry.get('marker-9001'); i++) await sleep(100);

  check('the grid rendered the markers the server returned',
    MARKERS.every(m => !!registry.get(`marker-${m.id}`)),
    `registered: ${MARKERS.map(m => !!registry.get(`marker-${m.id}`)).join(', ')}`);

  const srcs = MARKERS.map(m => shotSrc(m.id));

  check('every marker tile carries an image, not the letter fallback',
    srcs.every(Boolean), `srcs=${JSON.stringify(srcs)}`);

  // The fix: the parent scene's frame, not the marker's own (which returns
  // the placeholder).
  check('each tile is sourced from its parent scene\'s screenshot',
    MARKERS.every((m, i) => (srcs[i] || '').includes(`/scene/${m.sceneId}/thumb.png`)),
    `expected /scene/{1,2}/thumb.png, got ${JSON.stringify(srcs)}`);

  check('no tile is sourced from the marker\'s own frame',
    MARKERS.every((m, i) => !(srcs[i] || '').includes('scene_marker')),
    `srcs=${JSON.stringify(srcs)}`);

  // The user-visible symptom: two markers, two pictures.
  //
  // Kept only for diagnostics: under the reverted bug this still passes, as
  // the two marker-frame URLs differ as strings though both return the same
  // picture. The byte comparison below holds the line.
  check('two markers on two scenes render two different images',
    srcs[0] && srcs[1] && srcs[0] !== srcs[1],
    `srcs=${JSON.stringify(srcs)}`);

  // The bytes really differ, which makes the above more than a string check.
  // Compared by content, not length: these are 8x8 solid-colour PNGs, 74 bytes
  // whatever the colour, so a length check would pass on identical images.
  const shotBytes = await fetchBytes(srcs);
  check('the two images are genuinely different bytes',
    shotBytes.every(b => b.length) && !sameBytes(shotBytes[0], shotBytes[1]),
    `digests: ${shotBytes.map(digestOf).join(', ')}`);

  const placeholderBytes = await fetchBytes(MARKERS.map(m =>
    `/scene/${m.sceneId}/scene_marker/${m.id}/screenshot`));
  check('the marker\'s own frame is one identical placeholder for both',
    placeholderBytes.every(b => b.length) && sameBytes(placeholderBytes[0], placeholderBytes[1])
      && !sameBytes(placeholderBytes[0], shotBytes[0]),
    `digests: ${placeholderBytes.map(digestOf).join(', ')} — the reason the old fallback was unreachable`);

  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(document.getElementById('root')).render(<Harness />);
sleep(600).then(run).catch(async (e) => {
  check('driver completed', false, String(e && e.stack || e));
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  }).catch(() => {});
  await fetch('/done', { method: 'POST' }).catch(() => {});
});
