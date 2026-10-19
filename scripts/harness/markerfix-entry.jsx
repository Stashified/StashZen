/**
 * Headless driver for the marker grid's screenshot source.
 *
 * What was wrong was not a crash or a blank tile — it was that every tile
 * showed the *same* picture. Stash does not 404 an ungenerated marker
 * screenshot; it answers 200 with a built-in "Pending Generate" placeholder,
 * and on the live server all 332 markers returned it, byte for byte. So the
 * fallback in `normalizeMarker` — `m.screenshot || m.scene.paths.screenshot`,
 * marker's own frame first — never fell through, and the grid rendered one
 * identical stub for the whole library while a real 1920x1080 frame of the
 * parent scene sat in the same query result, unused.
 *
 * That shapes the checks. "An image loaded" would pass on the broken build, and
 * so would "the src is a URL". The observable is that **different markers show
 * different pictures**, which is only assertable if the fake serves different
 * bytes per scene — which is why server.py generates covers coloured by scene
 * id and one fixed placeholder for every marker frame.
 *
 *   marker 9001 → scene 1's frame     marker 9002 → scene 2's frame
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
 * Bodies, not lengths, because the difference being asserted is *which picture*
 * a tile shows. These images are all the same size — see the note at the check
 * that uses this — so anything measuring them would be measuring the wrong
 * thing.
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
  // Spatial nav and the grid's own key handling come from this; without it the
  // page never renders a usable tree.
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
  // Wait for the grid to leave its loading state rather than guessing: the
  // fetch goes through the real service layer and the real list cache.
  for (let i = 0; i < 40 && !registry.get('marker-9001'); i++) await sleep(100);

  check('the grid rendered the markers the server returned',
    MARKERS.every(m => !!registry.get(`marker-${m.id}`)),
    `registered: ${MARKERS.map(m => !!registry.get(`marker-${m.id}`)).join(', ')}`);

  const srcs = MARKERS.map(m => shotSrc(m.id));

  check('every marker tile carries an image, not the letter fallback',
    srcs.every(Boolean), `srcs=${JSON.stringify(srcs)}`);

  // The fix itself: the parent scene's frame, not the marker's own — which is
  // the URL that returns the placeholder.
  check('each tile is sourced from its parent scene\'s screenshot',
    MARKERS.every((m, i) => (srcs[i] || '').includes(`/scene/${m.sceneId}/thumb.png`)),
    `expected /scene/{1,2}/thumb.png, got ${JSON.stringify(srcs)}`);

  check('no tile is sourced from the marker\'s own frame',
    MARKERS.every((m, i) => !(srcs[i] || '').includes('scene_marker')),
    `srcs=${JSON.stringify(srcs)}`);

  // The user-visible symptom, stated the way the bug report stated it: two
  // markers, two pictures.
  //
  // This one is weaker than it looks and is kept only for its diagnostic value.
  // Under the reverted bug it still passes — the two marker-frame URLs differ
  // as strings even though both return the same picture — so it is the byte
  // comparison below, not this, that holds the line. A check named after the
  // symptom that cannot see the symptom is worth having only if the file says
  // so.
  check('two markers on two scenes render two different images',
    srcs[0] && srcs[1] && srcs[0] !== srcs[1],
    `srcs=${JSON.stringify(srcs)}`);

  // …and the bytes really are different, which is what makes the above more
  // than a string comparison.
  //
  // Compared by content, not by length: these are 8x8 solid-colour PNGs, and
  // *every* one of them is 74 bytes whatever the colour. A length check would
  // report two identical images here and pass — which it did, on the first run
  // of this file.
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
