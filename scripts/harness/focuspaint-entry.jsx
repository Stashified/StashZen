/**
 * focuspaint-entry.jsx — the paint-cost contract of a focus move in the
 * classic grids.
 *
 * Reported from the TV on 2026-10-18, after the Markers tab itself had been
 * fixed: "moving between scenes in markers tab is slow (in classic view mode)
 * — key press lag. List and carousel are fine. No such issues in regular
 * scenes mode." Then the two facts that located it: it appears at **6
 * columns** and it does **not appear in Test mode**. Test mode's covers are
 * small inline SVGs; Live mode's are 1920x1080 scene frames. So the per-press
 * cost scales with the *pixels already on screen*, which rules out the key
 * handler and the request layer, and points at paint.
 *
 * A focused card used to become `position: relative; z-index: 10` and to draw
 * its accent ring with an outside `box-shadow`. Changing an element from
 * static to positioned changes the grid's paint order, and the ring painted
 * over the neighbours. The engine answers that with an invalidation of the
 * whole grid stacking context, and re-rastering two dozen full-HD frames is
 * what the TV was spending the keypress on. The fix is `contain: content` on
 * each card plus an inset ring and no stacking change on focus — so the
 * invalidation stops at the card.
 *
 * WHAT THIS DRIVER CAN AND CANNOT SEE. It cannot time a paint, and it does not
 * try: this harness has no TV compositor, and a millisecond budget measured in
 * headless Firefox would be a number that silently stops meaning anything.
 * What it pins is the *structural* contract the cost turned on — focus must
 * leave `position` and `z-index` alone, the card must be paint-contained, and
 * the ring must be inset. Those are the properties that, if removed, restore
 * the expensive invalidation, and each has a red control.
 *
 * All four classic-grid cards are covered because they are four separate CSS
 * modules: a fix applied to one is a fix applied to one.
 */

import { createRoot } from 'react-dom/client';
import MarkerCard from '../../src/components/MarkerCard.jsx';
import VideoCard from '../../src/components/VideoCard.jsx';
import EntityCard from '../../src/components/EntityCard.jsx';
import PerformerCard from '../../src/components/PerformerCard.jsx';
import { TAG_VIEW } from '../../src/components/entityViews.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import '../../src/index.css';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// No art: every card falls back to its letter tile, which keeps the driver
// offline and makes the cards' own boxes the only thing that can differ.
const MARKER = {
  id: 'paint-marker', title: 'Paint marker', seconds: 42,
  scene: { id: '1', title: 'Paint scene' }, primaryTag: null, screenshot: null,
};
const VIDEO = { id: 'paint-video', title: 'Paint video', year: 2026, duration: '10:00' };
const TAG = { id: 'paint-tag', name: 'Paint tag', scene_count: 3, favorite: false, image_path: null };
const PERFORMER = { id: 'paint-performer', name: 'Paint performer', scene_count: 3, image_path: null };

function Harness() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, padding: 24 }}>
      <MarkerCard item={MARKER} index={0} onSelect={() => {}} />
      <VideoCard item={VIDEO} index={0} list={{ items: [VIDEO] }} onSelect={() => {}} />
      <EntityCard item={TAG} index={0} view={TAG_VIEW} onSelect={() => {}} />
      <PerformerCard item={PERFORMER} index={0} onSelect={() => {}} />
    </div>
  );
}

const CASES = [
  ['marker', 'marker-paint-marker', 'MarkerCard'],
  ['video', 'video-paint-video', 'VideoCard'],
  ['entity', 'tag-paint-tag', 'EntityCard'],
  ['performer', 'performer-paint-performer', 'PerformerCard'],
];

async function run() {
  for (let i = 0; i < 40 && !CASES.every(([, id]) => registry.has(id)); i++) await sleep(50);

  for (const [label, id, component] of CASES) {
    const el = registry.get(id)?.el;
    check(`F${CASES.findIndex(c => c[0] === label) + 1} ${component} is mounted`, !!el, `registry id ${id}`);
    if (!el) continue;

    const before = getComputedStyle(el);
    const positionBefore = before.position;
    const zBefore = before.zIndex;

    el.focus();
    await sleep(60);   // let React commit the focused class
    const after = getComputedStyle(el);

    check(
      `${label}: focusing does not change position or z-index`,
      after.position === positionBefore && after.zIndex === zBefore,
      `before position=${positionBefore} z=${zBefore}; after position=${after.position} z=${after.zIndex}`,
    );
    check(
      `${label}: the card is paint-contained`,
      /paint|content|strict/.test(after.contain),
      `contain=${after.contain || '(none)'}`,
    );
    check(
      `${label}: the focus ring is an inset outline, not an outside shadow`,
      after.outlineStyle === 'solid' && after.outlineWidth === '3px'
        && after.outlineOffset === '-3px' && after.boxShadow === 'none',
      `outline=${after.outlineStyle} ${after.outlineWidth} offset ${after.outlineOffset}; `
        + `box-shadow=${after.boxShadow || '(none)'}`,
    );
    check(
      `${label}: the focus scale is still applied`,
      after.transform !== 'none' && after.transform !== '',
      `transform=${after.transform || '(none)'}`,
    );
  }

  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

createRoot(document.getElementById('root')).render(<Harness />);
sleep(700).then(run).catch(async (e) => {
  check('driver completed', false, String(e && e.stack || e));
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  }).catch(() => {});
  await fetch('/done', { method: 'POST' }).catch(() => {});
});
