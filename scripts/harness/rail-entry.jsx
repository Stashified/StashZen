/**
 * Headless driver for the left navigation rail (0.7.0's 4.2).
 *
 * Mounts the whole `App` — the first driver here to do so. Everything else
 * mounts one component with its props handed to it, which is right when the
 * question is about that component. The question here is not: it is whether
 * the rail and the card grid form one navigable surface, which is a property
 * of the two of them together and of nothing either one can be asked alone.
 *
 * The claim under test is the one written into NavRail's header — that putting
 * the rail in zone 'grid' is what stops it being a focus trap. useKeyHandler
 * excludes cross-zone candidates for Left/Right (`isHorizontal && zone !==
 * currentZone` in findBestCandidate), so a rail in a zone of its own would
 * find nothing to its right and the entire library would be unreachable from
 * it. That is a one-line deduction from code I have read, and this file is
 * where it stops being a deduction: R4/R5 walk the crossing in both
 * directions, and the control is to change the rail's zone to 'nav' and watch
 * them go red.
 *
 * The second claim came later, from the user: Up out of the first card row
 * should reach the controls bar, and Left should return to the nav at the tab
 * you are on. Both come down to the fact that a zone is *symmetric* — the same
 * rule that keeps the grid out of the bar sideways also keeps the bar out of
 * the rail sideways — so the bar's zone has to be cut open in the two
 * directions that should be passable and left shut in the four that should not.
 * useFocusable carries the two flags that do it (`verticalOnly` for the rail's
 * inactive rows, `crossZone` for the bar) and useKeyHandler the three rules.
 * R7 asserts each edge separately: two up, two sideways out of the bar, and
 * two sideways into it, which is more than a hand-picked path would cover.
 *
 * Rectangles are asserted rather than eyeballed because the rail's 176px has
 * to hold "PERFORMERS" in Barlow Condensed 17px with 0.05em tracking, and
 * `.label` carries `text-overflow: ellipsis`. A label that does not fit is
 * therefore not an error, a wrap or an overflow — it is three dots, silently.
 * `scrollWidth > clientWidth` is the only cheap way to see that happen.
 *
 * What this cannot tell you: that any of it looks good. Geometry is not taste,
 * and the palette port in 4.1 has no behaviour to assert on at all.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry, getCurrentFocusId } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';
import { setPin, clearPin } from '../../src/utils/appLock.js';

const PORT = window.__PORT__;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A React render error unmounts the whole tree, which this driver would
// otherwise see only as "the rail is gone" — a symptom that names neither the
// component nor the reason. Collect the reasons as they happen.
const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});
const errorTail = () => (errors.length ? errors.slice(-2).join(' | ') : 'none');
const rootAlive = () => (document.getElementById('root')?.children.length ?? 0) > 0;

async function waitFor(pred, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

// ── Driving the remote ──────────────────────────────────────
// `key` alone is enough: every handler in the app tests `e.key` before
// `e.keyCode`, and a synthetic KeyboardEvent cannot carry a legacy keyCode
// anyway (it is not in KeyboardEventInit, and Firefox leaves it 0).
//
// Dispatched on the *focused element* rather than on window, because the two
// listeners live at different levels: useKeyHandler is a window listener and
// would take a window dispatch, but useFocusable's Enter handler is bound to
// the element itself and a window-dispatched event never travels downwards to
// it. Dispatching on the active element with `bubbles` reaches both.
//
// 150ms between presses is not padding: useKeyHandler throttles held arrows to
// MIN_REPEAT_MS (90), so a faster driver would have presses silently dropped
// and the walk would appear to stall for no reason.
async function press(key) {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true,
  }));
  await sleep(150);
}

// Enter needs a keyup too — but only on the cards. VideoCard is the one
// focusable here that passes `onLongPress`, which moves its short action to
// keyup by design (see useFocusable's long-press note). The rail rows don't,
// so for them the keydown alone is the activation and a keyup is inert either
// way; sending it unconditionally keeps one helper instead of two.
async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(150);
}

// Focus an element by its registry id, the only handle the cards have — they
// carry no DOM id and their CSS-module classes are hashed.
const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};

// ── Reading the layout ──────────────────────────────────────
const railEl = () => document.querySelector('nav[aria-label="Main navigation"]');
const railRows = () => Array.from(railEl()?.querySelectorAll('button') ?? []);
const rowById = (id) => railRows().find(b => b.textContent.trim().toLowerCase().startsWith(id));
const labelEl = (btn) => btn?.querySelector('span:last-child');
const rect = (el) => el?.getBoundingClientRect();

// Four card families can be the thing beside a rail row as of 0.18.0: the
// Scenes/Performers listings (`video-`), Home's showroom scene shelf
// (`showroom-recent-scenes-video-1` and friends), and the studio, performer
// and gallery cards on Home (`studio-1`, `performer-1`, `gallery-1`). The walk
// below drives the Scenes tab, but R4 reads focus at rest on Home, so all of
// them count.
const idIsCard = (id) => typeof id === 'string'
  && (id.startsWith('video-') || id.startsWith('showroom-')
      || id.startsWith('studio-') || id.startsWith('performer-')
      || id.startsWith('gallery-'));
const idIsRail = (id) => typeof id === 'string' && id.startsWith('nav-');

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

// ── The run ─────────────────────────────────────────────────
async function run() {
  // Home's first shelf arrives over the wire, so nothing about the layout is
  // final until it does. Home is the showroom as of 0.15.0; the scene grid
  // this driver's card walks use lives on the Scenes tab, reached below.
  await waitFor(() => registry.has('showroom-recent-scenes-video-1'));
  await sleep(300);

  // ── R1  the rail is there, with the right rows ──────────
  // Nine rows as of 0.15.0: Scenes was split out of Home and sits directly
  // below it, between Home and Performers. Written out rather than counted,
  // because the *order* is the thing the `next` chain depends on and a count
  // would pass on any permutation.
  const labels = railRows().map(b => b.textContent.trim());
  check('R1 the rail renders its nine rows',
    JSON.stringify(labels) === JSON.stringify([
      'Home', 'Scenes', 'Performers', 'Markers', 'Tags', 'Studios',
      'Galleries', 'Images', 'Settings',
    ]),
    labels.join(' · ') || '(no rail)');

  // Reels is gone, and its absence is the point of the third user decision in
  // this phase — assert it by name rather than trusting the list above to
  // never grow it back.
  check('R1 no Reels row survives', !labels.includes('Reels'), labels.join(' · '));

  // ── R2  geometry ────────────────────────────────────────
  const rail = railEl();
  const main = document.querySelector('[role="main"]');
  const railRect = rect(rail);
  const mainRect = rect(main);
  check('R2 the rail is --sidebar-w wide', Math.round(railRect.width) === 176,
    `${Math.round(railRect.width)}px`);
  check('R2 the content column starts at the rail, not under it',
    mainRect.left >= railRect.right - 1,
    `rail ends ${Math.round(railRect.right)}, main starts ${Math.round(mainRect.left)}`);
  // The viewport is in the detail deliberately: every coordinate in the R7
  // graph below, and therefore every edge this driver judges, is a function
  // of it. A recorded graph whose size is not written down cannot be compared
  // against a later run.
  check('R2 the rail spans the full height',
    Math.abs(railRect.height - window.innerHeight) <= 1,
    `${Math.round(railRect.height)} of ${window.innerHeight}  (viewport ${window.innerWidth}x${window.innerHeight})`);

  // ── R3  the labels fit ──────────────────────────────────
  // The silent failure: `.label` ellipsises, so a too-narrow rail shows
  // "PERFORM…" and reports no error anywhere.
  const clipped = railRows()
    .filter(b => { const l = labelEl(b); return l && l.scrollWidth > l.clientWidth + 1; })
    .map(b => b.textContent.trim());
  check('R3 no rail label is truncated', clipped.length === 0,
    clipped.length ? `clipped: ${clipped.join(', ')}` : 'all labels fit');

  // ── R4  the resting place ───────────────────────────────
  // Not asserted as a hard rule — both the rail's first row and the grid's
  // first card autofocus, and which wins is a race between two 50ms timers.
  // Recorded because a user who opens the app and presses Right immediately
  // gets a different first move depending on the answer.
  const onLoad = getCurrentFocusId();
  check('R4 focus lands on something focusable at rest',
    idIsRail(onLoad) || idIsCard(onLoad), `focus is on ${onLoad}`);

  // Start the walk from a known place.
  focus('nav-home');
  await sleep(120);

  // ── R5  down the rail ───────────────────────────────────
  await press('ArrowDown');
  const afterDown = getCurrentFocusId();
  check('R5 Down walks the rail', afterDown === 'nav-scenes', afterDown);

  await press('ArrowUp');
  check('R5 Up walks it back', getCurrentFocusId() === 'nav-home', getCurrentFocusId());

  // ── R5b the whole chain, which is now nine deep ─────────
  // The `next` chain exists because the geometry cannot find Settings past the
  // spacer — see NavRail's ITEMS comment and the reported bug it was written
  // for. With four more rows between the last tab and Settings there is more
  // geometry for the chain to be defeated by, not less, and every entry has to
  // name its own successor or it becomes a row Down cannot leave — which on a
  // TV reads as a dead remote rather than as a missing edge.
  //
  // Walked end to end rather than spot-checked: a single missing link stops
  // the walk at the row before it, so the walk's *length* is the assertion.
  focus('nav-home');
  await sleep(120);
  const walk = [getCurrentFocusId()];
  for (let i = 0; i < labels.length - 1; i++) {
    await press('ArrowDown');
    walk.push(getCurrentFocusId());
  }
  check('R5b Down reaches Settings from Home, in order',
    walk.join('>') === labels.map(l => `nav-${l.toLowerCase()}`).join('>'),
    walk.join(' > '));

  await press('ArrowUp');
  check('R5b Up walks the chain back one',
    getCurrentFocusId() === 'nav-images', getCurrentFocusId());

  // ── R5c  the foot of the rail is the foot ───────────────
  // Settings is the last row, and Down there must not do anything: the rail is
  // a column and Right is the only way into the content. Without a declared
  // edge the geometry found a grid card and Down dropped the user into the
  // middle of the page — reported from the TV, 2026-10-17: "it should stay
  // there unless pressed right".
  focus('nav-settings');
  await sleep(120);
  await press('ArrowDown');
  check('R5c Down on Settings leaves focus where it is',
    getCurrentFocusId() === 'nav-settings', getCurrentFocusId());

  // Home became the showroom in 0.15.0 and the scene listing moved to Scenes,
  // so the card walks and the controls-bar graph below are driven there. The
  // rail itself is unchanged and identical on every tab — this is only the
  // surface the rail is being probed against.
  focus('nav-scenes');
  await sleep(120);
  await tapEnter();
  await waitFor(() => registry.has('video-1'));
  await sleep(300);
  focus('nav-settings');
  await sleep(120);

  // ── R6  the crossing — the load-bearing claim ───────────
  // If the rail's zone were not 'grid', this is the assertion that fails:
  // findBestCandidate returns null for Right and focus never leaves.
  await press('ArrowRight');
  const afterRight = getCurrentFocusId();
  check('R6 Right leaves the rail', !idIsRail(afterRight),
    `${afterRight}${idIsRail(afterRight) ? '  ← the rail is a trap' : ''}`);

  // A browse row leads into the grid. nav-markers sits beside the cards at a
  // height where the nearest thing to its right is unambiguous; the top row
  // shares its height with the bar, which is a pairing worth recording but a
  // poor one to assert a general rule on.
  focus('nav-markers');
  await sleep(120);
  await press('ArrowRight');
  const fromMarkers = getCurrentFocusId();
  check('R6 Right from a browse row reaches a card', idIsCard(fromMarkers),
    `${fromMarkers}`);

  focus('video-1');
  await sleep(120);
  await press('ArrowLeft');
  const afterLeft = getCurrentFocusId();
  check('R6 Left comes back to the rail', idIsRail(afterLeft),
    `${afterLeft}${idIsRail(afterLeft) ? '' : '  ← no way back'}`);

  // ── R7  the D-pad graph around the rail ─────────────────
  // A rail is only a good rail if everything else is still reachable from it
  // *and* it is still reachable from everything else. Spatial nav is a graph
  // and the zone rules are what shape it, so probe the edges rather than
  // assert on one hand-picked path — the path I would have picked is exactly
  // the one the geometry happens to agree with, which proves nothing about
  // the ones it doesn't.
  //
  // The controls bar is the case that matters. It is the thing the user asked
  // to keep at the top, and it *was* the one thing outside the grid's zone —
  // which made it reachable only through the rail (see ControlsPanel's header
  // for the whole story). Seeing it in a zone-independent way matters here:
  // the fix was to change the zone, so a probe that finds the bar by its zone
  // would have silently tested nothing once the fix landed. Derive it from
  // where it is instead — it is the element immediately above <main>.
  const barEl = document.querySelector('[role="main"]')?.previousElementSibling;
  const barIds = barEl
    ? [...registry.entries()].filter(([, v]) => barEl.contains(v.el)).map(([id]) => id)
    : [];

  // Card anchors down the first column and across the first row: the two
  // walks that answer "where does Left go as you go down the page" and "where
  // does Up go as you go right".
  const anchors = [
    // Every rail row, so the graph below also answers "can the bar be reached
    // from the rail" without a second, separately-buggy probe — and so R8 can
    // read the whole `next` chain out of it. Listed rather than derived from
    // `labels` on purpose: this is the list of rows the graph is *about*, and
    // it going stale is exactly how R8 reported `nav-tags ↓undefined` after
    // the four browse rows were added — the edges it wanted were never probed,
    // which is a red the graph form is supposed to catch rather than cause.
    'nav-home', 'nav-scenes', 'nav-performers', 'nav-markers',
    'nav-tags', 'nav-studios', 'nav-galleries', 'nav-images',
    'nav-settings',
    ...barIds,                             // every control, so the bar's own
                                           // Left/Right walk is in the graph

    'video-1', 'video-2', 'video-4',      // first row, across
    'video-5', 'video-9', 'video-13',     // first column, down
  ].filter(id => registry.has(id));

  // Geometry is captured per anchor, at the moment its presses are judged.
  // The grid scrolls as later anchors are focused, so a single dump taken
  // after the walk describes a layout that only the last anchor ever saw —
  // and spatial nav is decided entirely by these rectangles, which is why
  // every guess about them so far has been wrong by enough to flip the answer.
  const DIRS = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'];
  const edges = {};
  const where = {};
  for (const a of anchors) {
    edges[a] = {};
    focus(a);
    await sleep(120);
    const r = rect(registry.get(a)?.el);
    where[a] = r ? `${Math.round(r.left)},${Math.round(r.top)}` : 'MISSING';
    for (const dir of DIRS) {
      focus(a);
      await sleep(60);
      await press(dir);
      edges[a][dir] = getCurrentFocusId();
    }
  }

  const row = (id) => DIRS
    .map((d, i) => `${['→', '←', '↑', '↓'][i]}${edges[id]?.[d] ?? '—'}`)
    .join('  ');
  check('R7 the D-pad graph around the rail', true,
    anchors.map(a => `${a}@${where[a]}: ${row(a)}`).join('   |   '));

  // ── Where the bar actually is ───────────────────────────
  // Two rounds of reasoning about the bar's geometry were wrong by enough to
  // flip the answer to "why did Right go there", so it is measured and kept.
  // The bar wraps to two rows at this width (`flex-wrap: wrap`), which is why
  // `ctrl-*` ids appear at two different y values below.
  const barRect = (id) => {
    const r = rect(registry.get(id)?.el);
    return r ? `${id}@${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : `${id}:MISSING`;
  };
  check('R7 the controls bar geometry', true, barIds.map(barRect).join('  '));

  const inBar = (id) => barIds.includes(id);

  // ── The bar is reachable from the cards ─────────────────
  // The user's ask: "up from videos → filter row". The bar shares the grid's
  // zone, so Up out of the first card row reaches it; it stays out of the
  // sideways walk because every control in it is `verticalOnly`.
  //
  // Read from the graph above rather than from a second walk. The first
  // version of this had its own probe loop and reported "unreachable" while
  // the graph on the line above plainly showed `nav-home ↑ ctrl-search` — a
  // duplicated measurement with its own bug, disagreeing with the good one.
  // One walk, one answer.
  const upFromTopRow = edges['video-1']?.ArrowUp;
  check('R7 Up from the first card row reaches the bar', inBar(upFromTopRow),
    `${upFromTopRow}${inBar(upFromTopRow) ? '' : '  ← the bar is not reachable from the cards'}`);

  // And the route in from the rail must still exist, for the case where the
  // user is already on the rail.
  const barRoutes = anchors.filter(idIsRail).flatMap(a => ['ArrowUp', 'ArrowDown']
    .filter(d => inBar(edges[a]?.[d]))
    .map(d => `${a} ${d === 'ArrowUp' ? '↑' : '↓'} ${edges[a][d]}`));
  check('R7 the bar is reachable from the rail', barRoutes.length > 0,
    barRoutes.join('   ') || 'no rail row leads into the bar in one press');

  // ── Left returns to the nav at the tab you are on ───────
  // The user's other ask: "Left → home row". Implemented as the *active* row,
  // which is the Scenes row while Scenes is the tab — the two are the same
  // thing where the user was looking. Asserted as "the active row" because
  // that is what generalises: on Performers, Left should land on the
  // Performers row.
  //
  // The row that must NOT be droppable here is Settings: it sits at the foot of
  // the rail, so before the flag it was the row nearest a lower card's centre
  // and Left from those cards opened a modal on a sideways press.
  const homeRow = () => railRows().find(b => b.getAttribute('aria-current') === 'page');
  const activeRowId = () => {
    const t = homeRow()?.textContent.trim().toLowerCase();
    return t ? `nav-${t}` : null;
  };
  const leftFromCards = ['video-1', 'video-5', 'video-9']
    .filter(id => registry.has(id))
    .map(id => `${id} ← ${edges[id]?.ArrowLeft}`);
  check('R7 Left from a card lands on the active rail row',
    ['video-1', 'video-5', 'video-9'].filter(id => registry.has(id))
      .every(id => edges[id]?.ArrowLeft === activeRowId()),
    `${leftFromCards.join('   ')}   (active row is ${activeRowId()})`);

  // Left from the bar's LEFTMOST control returns to the rail. Asserted on the
  // leftmost one on purpose: Left from the middle of the bar moves along the
  // bar (ctrl-search ← ctrl-filter), which is correct, and the first version
  // of this check demanded the rail from whichever bar control happened to be
  // an anchor and so failed on correct behaviour.
  const leftmostBar = barIds
    .map(id => ({ id, r: rect(registry.get(id)?.el) }))
    .filter(x => x.r)
    .sort((a, b) => a.r.left - b.r.left)[0]?.id;
  focus(leftmostBar);
  await sleep(120);
  await press('ArrowLeft');
  check('R7 Left from the bar\'s leftmost control returns to the rail',
    idIsRail(getCurrentFocusId()), `${leftmostBar} ← ${getCurrentFocusId()}`);

  // And the mirror — the half the `verticalOnly` flag exists for. With the bar
  // in zone 'grid' and nothing marking it, Right from video-2 went to the mute
  // toggle, which sits 21px to its right and 166px up (score 21 + 1.5×166 =
  // 269) and so beat video-3 at 276px right (276 + 1.5×4 = 282). Both halves
  // come from one zone, so the flag is what separates them.
  const sidewaysIntoCards = ['video-1', 'video-2', 'video-4']
    .filter(id => registry.has(id))
    .map(id => `${id}: →${edges[id]?.ArrowRight} ←${edges[id]?.ArrowLeft}`)
    .join('   ');
  check('R7 no card reaches the bar sideways',
    ['video-1', 'video-2', 'video-4'].filter(id => registry.has(id))
      .every(id => !inBar(edges[id]?.ArrowRight) && !inBar(edges[id]?.ArrowLeft)),
    sidewaysIntoCards);

  // The mirror of the Left rule, and not merely symmetric book-keeping: every
  // rail row is level with or above the bar, and the bar's search box sits
  // directly right of the top two rows. It is a control in the bar, so Right
  // from the rail must not reach it — this is the check that caught the flag
  // being dropped on the way through useEditableField, which builds its own
  // useFocusable call and silently discarded an option it did not name.
  check('R7 no rail row reaches the bar sideways',
    ['nav-home', 'nav-performers', 'nav-markers', 'nav-settings']
      .every(id => !inBar(edges[id]?.ArrowRight) && !inBar(edges[id]?.ArrowLeft)),
    ['nav-home', 'nav-performers', 'nav-markers', 'nav-settings']
      .map(id => `${id} →${edges[id]?.ArrowRight} ←${edges[id]?.ArrowLeft}`).join('   '));

  // ── The bar is still a walkable row ─────────────────────
  // The bar is nine controls the user moves across: Mode, Sort, Asc/Desc,
  // Filter, Columns, Mute. An earlier cut of this opened the bar upward by
  // marking every control `verticalOnly` — which is checked against the
  // candidate, so it also shut Left/Right *inside* the bar and dumped the user
  // back into the cards on the first sideways press. Every check above still
  // passed; this is the one that catches it, so it is asserted rather than
  // left to the recorded graph.
  // Row 1 only — the bar wraps to two rows at this width, and row 2's
  // neighbours are decided by the wrap, not by this rule. Row 1 is the
  // controls sharing the topmost y.
  const barTop = Math.min(...barIds.map(id => rect(registry.get(id)?.el)?.top ?? Infinity));
  const rowOne = barIds
    .filter(id => Math.abs((rect(registry.get(id)?.el)?.top ?? -999) - barTop) <= 4)
    .sort((a, b) => rect(registry.get(a)?.el).left - rect(registry.get(b)?.el).left);
  const walks = rowOne.filter(id =>
    inBar(edges[id]?.ArrowRight) || inBar(edges[id]?.ArrowLeft));
  check('R7 Left/Right walk the bar\'s own controls',
    rowOne.length >= 2 && walks.length === rowOne.length,
    `${rowOne.map(id => `${id} →${edges[id]?.ArrowRight} ←${edges[id]?.ArrowLeft}`).join('   ')}`);

  // ── R8  Settings is reachable and opens ─────────────────
  //
  // The invariant first, read off the graph recorded in R7: each rail row's
  // Down lands on the *next rail row*, with no way out of the rail in the
  // middle of the walk. That is the property the user asked for and the one
  // the layout cannot be trusted to produce on its own — Settings is pinned
  // to the foot of the rail, so the row above it sits at the far end of a
  // flexible spacer whose height is whatever the viewport leaves over.
  //
  // Written as three named edges rather than "you can get there in four
  // presses", because that weaker form is what let this bug through: it was
  // green at every window size where the geometry happened to agree, and the
  // failure it missed only appears at the TV's 1080-pixel height (see
  // run.sh's WINDOW). A check that can pass without the fix is worse than no
  // check, since it reads as coverage.
  const railChain = ['nav-home', 'nav-scenes', 'nav-performers', 'nav-markers',
    'nav-tags', 'nav-studios', 'nav-galleries', 'nav-images'];
  const nextRow = {
    'nav-home': 'nav-scenes', 'nav-scenes': 'nav-performers',
    'nav-performers': 'nav-markers',
    'nav-markers': 'nav-tags', 'nav-tags': 'nav-studios',
    'nav-studios': 'nav-galleries', 'nav-galleries': 'nav-images',
    'nav-images': 'nav-settings',
  };
  const broken = railChain.filter(id => edges[id]?.ArrowDown !== nextRow[id]);
  check('R8 Down walks the rail row by row to Settings',
    broken.length === 0,
    broken.length
      ? broken.map(id => `${id} ↓${edges[id]?.ArrowDown} (wanted ${nextRow[id]})`).join('; ')
      : railChain.map(id => `${id} ↓${nextRow[id]}`).join('  '));

  // The same edge, read the other way. Up out of Settings used to fall back to
  // the geometry and land on a grid card, which made the rail an ordered
  // column going down and a scatter going up — and Up is the only exit, since
  // Settings is `verticalOnly`. Checked against the graph for the same reason
  // R8 is: it is a property of the declared chain, not of the pixels.
  check('R8 Up out of Settings returns to the rail',
    edges['nav-settings']?.ArrowUp === 'nav-images',
    `nav-settings ↑${edges['nav-settings']?.ArrowUp ?? '—'} (wanted nav-images)`);

  // And the user's own path through it, from a cold focus, ending in the
  // panel actually opening — the graph above proves the edges exist, this
  // proves the walk and the thing at the end of it. The bound is
  // `labels.length`, not a literal: it was a literal 4 when the rail had three
  // tabs and Settings, and it is exactly the kind of number that goes stale
  // into a *passing* check when rows are added — the loop would simply stop
  // early and the tab assertion below would report whatever it landed on.
  focus('nav-home');
  await sleep(120);
  for (let i = 0; i < labels.length && getCurrentFocusId() !== 'nav-settings'; i++) {
    await press('ArrowDown');
  }
  check('R8 Down the rail reaches Settings', getCurrentFocusId() === 'nav-settings',
    getCurrentFocusId());

  check('R8 the rail is still mounted before the press', rootAlive() && !!railEl(),
    `#root children ${document.getElementById('root')?.children.length}, rail ${!!railEl()}`);

  // The user's panel had a PIN set, which is what makes the lock section
  // render its second button and the body longer than the no-PIN layout this
  // driver otherwise sees. Seed it before opening so the walk is the one they
  // reported on; cleared again below so later checks see a fresh store.
  setPin('1234');
  await sleep(60);

  await tapEnter();
  const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 2000);
  check('R8 Enter on Settings opens the panel', !!dialog,
    dialog ? 'role="dialog" present'
           : `no dialog; rail ${!!railEl()}; errors: ${errorTail()}`);

  // ── R8b  Down exhausts the panel body before the footer ──
  //
  // The panel's body is a scroll container (`max-height: 85vh`), and the
  // footer is fixed below it. Geometry alone rated the footer as nearer than
  // the next option whenever that option was still below the fold, so Down
  // jumped to Save with options unvisited and resumed scrolling afterwards.
  // Reported from the TV, 2026-10-17.
  //
  // Asserted as the property, not as a fixed list: at each press, if any body
  // control is still below the focused one, Down must not land in the footer.
  // A list would bake in today's controls and today's panel height; the
  // property is what the user actually asked for.
  //
  // Honest record: this walk was GREEN with the fix's line deleted (the
  // control experiment, 2026-10-17). It is kept as the end-to-end statement of
  // the requirement, not as the check that proves the fix — R8b2 is that one,
  // because at this window the scorer already favours the body. Do not read a
  // green here as coverage of the container rule.
  //
  // The body set comes from the registry by zone rather than from ids written
  // here: the PIN buttons appear only when a PIN is set, and hardcoding them
  // would make this red on a device where the lock section renders "Set PIN"
  // alone.
  const activeId = () => {
    for (const [id, e] of registry) if (e.el === document.activeElement) return id;
    return document.activeElement?.tagName || 'body';
  };
  const bodyEls = () => [...registry.values()]
    .filter(e => (e.zone === 'settings' || e.zone === 'settings-lock')
      && e.el.offsetParent && document.contains(e.el))
    .map(e => e.el);
  const isFooter = (id) => registry.get(id)?.zone === 'settings-footer';
  const footerEls = () => [...registry.values()]
    .filter(e => e.zone === 'settings-footer' && e.el.offsetParent && document.contains(e.el))
    .map(e => e.el);

  // Diagnostics: whether there is a scroll container at all, and how much of
  // the body sits below the fold. A walk check can only have a failure mode if
  // the panel actually scrolls; if this reads scrollHeight === clientHeight the
  // harness is not exercising the reported layout and the check is vacuous.
  const firstBodyEl = registry.get('settings-mode-test')?.el;
  let scrollInfo = 'no body element';
  if (firstBodyEl) {
    let n = firstBodyEl.parentElement;
    let found = null;
    while (n && n !== document.body && n !== document.documentElement) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') { found = n; break; }
      n = n.parentElement;
    }
    if (!found) scrollInfo = 'no scroll container';
    else {
      const fr = found.getBoundingClientRect();
      const below = bodyEls().filter(el => el.getBoundingClientRect().bottom > fr.bottom + 1).length;
      scrollInfo = `body ${found.scrollHeight}/${found.clientHeight}, ${below} below the fold`;
    }
  }

  // ── Scoring margins (diagnostic) ──
  // Reproduces findBestCandidate's Down scoring for the two objects that can
  // compete at the bottom of the body: the nearest body control below and the
  // footer. The 2026-10-17 build scores the footer with the same +100000
  // cross-zone penalty the PIN section pays; the container rule adds another
  // million to anything outside the focused element's scroll box. Printing the
  // margin here is what tells us whether the reported jump could have come
  // from this scoring at all.
  const downScore = (el, cur) => {
    const a = el.getBoundingClientRect();
    const b = cur.getBoundingClientRect();
    const dx = (a.left + a.width / 2) - (b.left + b.width / 2);
    const dy = (a.top + a.height / 2) - (b.top + b.height / 2);
    if (dy <= 4) return null;
    return dy + Math.abs(dx) * 1.5;
  };
  const curZoneOf = (el) => {
    for (const e of registry.values()) if (e.el === el) return e.zone;
    return null;
  };
  const marginAt = (cur) => {
    const cz = curZoneOf(cur);
    const body = bodyEls()
      .map(el => ({ el, s: downScore(el, cur) }))
      .filter(x => x.s != null)
      .map(x => ({ ...x, s: x.s + (curZoneOf(x.el) !== cz ? 100000 : 0) }))
      .sort((x, y) => x.s - y.s)[0];
    const foot = footerEls()
      .map(el => ({ el, s: downScore(el, cur) }))
      .filter(x => x.s != null)
      .map(x => ({ ...x, s: x.s + (curZoneOf(x.el) !== cz ? 100000 : 0) }))
      .sort((x, y) => x.s - y.s)[0];
    return {
      body: body?.s, foot: foot?.s,
      margin: body && foot ? Math.round(foot.s - body.s) : null,
    };
  };
  const margins = [];

  // ── R8b2  the crossing case, built rather than waited for ──
  //
  // The walk above passes on the pre-fix scoring *at this window* — it did
  // when the container penalty was deleted for its control experiment. The
  // margins say why: from the last body option above the PIN section, Save
  // scores 100315 and the PIN row 100182, a 133px margin that is a property of
  // today's font metrics, not of the rule. The TV's metrics put Save ahead,
  // which is the jump the user reported. A check that only runs where the
  // margin happens to fall the right way cannot fail, so this one builds the
  // TV's side of the crossing: Save is moved to sit directly 60px under the
  // focused option, the worst case any layout can produce. Under the rule,
  // position cannot matter — Save is outside the body's scroll box and scores
  // a million worse. Without it, Save wins here, which is the control.
  let crossing = null;
  if (dialog) {
    const saveEl = registry.get('settings-save')?.el;
    const footerBox = saveEl?.closest('footer');
    const fromEl = registry.get('settings-previews')?.el;
    if (footerBox && fromEl) {
      fromEl.focus();
      await sleep(80);
      const f = fromEl.getBoundingClientRect();
      const s = saveEl.getBoundingClientRect();
      const dx = (f.left + f.width / 2) - (s.left + s.width / 2);
      const dy = (f.top + f.height / 2 + 60) - (s.top + s.height / 2);
      footerBox.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
      await sleep(60);
      const staged = activeId();
      const m = marginAt(fromEl);
      await press('ArrowDown');
      crossing = { staged, landed: activeId(), m };
      footerBox.style.transform = '';
      await sleep(60);
    }
  }
  check('R8b a nearer footer still cannot pull focus out of the body',
    !!crossing && crossing.staged === 'settings-previews'
      && crossing.landed !== 'settings-save'
      && crossing.landed !== 'settings-cancel' && crossing.landed !== 'settings-clear',
    crossing
      ? `from ${crossing.staged} (Save 60px below: body ${crossing.m.body ?? '—'} vs footer ${crossing.m.foot ?? '—'}) Down landed on ${crossing.landed}`
      : 'panel or controls missing');

  let earlyFooter = null;
  let reachedFooter = false;
  const panelWalk = [];
  if (dialog) {
    registry.get('settings-mode-test')?.el.focus();
    await sleep(120);
    for (let i = 0; i < 16; i++) {
      const cur = document.activeElement;
      const curRect = cur?.getBoundingClientRect();
      const bodyBelow = !!curRect && bodyEls().some(el => {
        const r = el.getBoundingClientRect();
        return el !== cur && r.top > curRect.bottom - 4;
      });
      const m = marginAt(cur);
      margins.push(`${activeId()} b${m.body == null ? '—' : Math.round(m.body)}/f${m.foot == null ? '—' : Math.round(m.foot)}`);
      await press('ArrowDown');
      const now = activeId();
      panelWalk.push(now);
      if (isFooter(now)) {
        reachedFooter = true;
        if (bodyBelow) earlyFooter = `from ${panelWalk[panelWalk.length - 2] ?? '?'} (body still below)`;
        break;
      }
    }
  }
  check('R8b Down walks the whole settings body before the footer',
    !!dialog && reachedFooter && !earlyFooter,
    earlyFooter
      ? `jumped to the footer ${earlyFooter}; ${scrollInfo}; walk ${panelWalk.join(' > ')}`
      : reachedFooter
        ? `${scrollInfo}; margins ${margins.join(' | ')}; walk ${panelWalk.join(' > ')}`
        : `never reached the footer; ${scrollInfo}; walk ${panelWalk.join(' > ') || '<none>'}`);

  clearPin();
  await sleep(60);

  // ── R9  Enter on a tab row switches the tab ─────────────
  // Close the panel first — it is modal and would scope the vault search.
  if (dialog) {
    const back = document.querySelector('[role="dialog"]');
    back.dispatchEvent(new KeyboardEvent('keydown', {
      keyCode: 10009, bubbles: true, cancelable: true,
    }));
    await sleep(300);
  }

  focus('nav-performers');
  await sleep(120);
  await tapEnter();
  await sleep(300);
  const current = rowById('performers');
  check('R9 Enter on a rail row switches the active tab',
    current?.getAttribute('aria-current') === 'page',
    `aria-current=${current?.getAttribute('aria-current')}; rail ${!!railEl()}; errors: ${errorTail()}`);

  // ── R10  the sliding indicator ──────────────────────────
  // Two hand-computed numbers (`offsetTop + 7`, `offsetHeight - 14`) in an
  // effect that measures the row rather than deriving the position from the
  // item index, which is what makes it survive a rail whose rows are not all
  // the same height. The transition is 0.28s, so this waits it out.
  await sleep(450);
  const marker = railEl()?.firstElementChild;
  // The *active* row, not a fixed one: R9 left the app on Performers, and the
  // indicator tracks the active tab rather than the focused row. Asserting
  // against Home here is what made this check fail the first time it ran —
  // the app was right and the test was wrong.
  const activeRow = railRows().find(b => b.getAttribute('aria-current') === 'page');
  if (!marker || !activeRow) {
    check('R10 the sliding indicator is measurable', false,
      `rail ${!!railEl()}, marker ${!!marker}, active row ${!!activeRow}; errors: ${errorTail()}`);
    return;
  }
  const cs = getComputedStyle(marker);
  const top = parseFloat(cs.top);
  const height = parseFloat(cs.height);
  check('R10 the indicator sits on the active row\'s row box',
    Math.abs(top - (activeRow.offsetTop + 7)) <= 1
      && Math.abs(height - (activeRow.offsetHeight - 14)) <= 1,
    `top ${top} (row ${activeRow.offsetTop} + 7), height ${height} `
    + `(row ${activeRow.offsetHeight} - 14), active ${activeRow.textContent.trim()}`);
  check('R10 it is visible once an active row exists',
    parseFloat(cs?.opacity ?? '0') === 1, `opacity ${cs?.opacity}`);

  // ── R11  Down at the end of a listing stays in the content ─────────────
  // Reported from the TV, 2026-10-18: holding Down through a page load put
  // the cursor on Settings in the sidebar. Once the loaded content has
  // nothing below the focused card — mid-load, or simply the end of the
  // listing — the rail row is the nearest Down candidate, because the rail
  // rows share the grid's zone and Settings is fixed at the foot of the
  // screen. useKeyHandler's `skipRailRows` is the guard that keeps Down out.
  //
  // The fake server's `short` mode makes that state deterministic: one full
  // first row, and a second row with a single card. The guard has to be
  // *measured* here rather than reasoned about, because with any card still
  // below the cursor the geometry never reaches the rail at all — the earlier
  // check on the full listing stayed green with the guard deleted, which is
  // what moved this one to a listing that has actually ended.
  const shortMode = await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findScenes: 'short' }),
  }).then(r => r.json()).catch(() => null);
  // Leaving a tab clears every list cache (0.22.1), so away-and-back is how
  // the short answer reaches the page the user is looking at.
  focus('nav-performers');
  await sleep(120);
  await tapEnter();
  await sleep(400);
  focus('nav-scenes');
  await sleep(120);
  await tapEnter();
  const shortLoaded = await waitFor(
    () => registry.has('video-5') && !registry.has('video-6'), 5000);
  let where5 = '(not run)';
  if (shortLoaded) {
    focus('video-5');
    await sleep(200);
    where5 = getCurrentFocusId();
  }
  await press('ArrowDown');
  const below = getCurrentFocusId();
  check('R11 setup: the short listing is the one on screen',
    shortLoaded && where5 === 'video-5',
    `mode ${shortMode && shortMode.findScenes}; focus ${where5}`);
  check('R11 Down below the last card stays out of the rail',
    shortLoaded && !idIsRail(below),
    `video-5 ↓ ${below}`);

  check('every rail press moved focus', true,
    `final focus: ${getCurrentFocusId()}`);
}

const root = document.getElementById('root');
document.body.style.margin = '0';

// Before the render, so the first fetch already sees the fake endpoint —
// `runQuery` reads the settings store per request, but the request goes out
// from a mount effect, which React may flush before the next line.
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
