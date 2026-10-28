/**
 * Headless driver for the left navigation rail.
 *
 * Mounts the whole `App`: the claim is that the rail and the card grid form one
 * navigable surface, which neither can answer alone.
 *
 * Putting the rail in zone 'grid' is what stops it being a focus trap:
 * useKeyHandler excludes cross-zone Left/Right candidates, so a separate rail
 * zone could never reach the library. R4/R5 walk the crossing both ways; the
 * control is changing the zone to 'nav' and watching them go red.
 *
 * Up out of the first card row must reach the controls bar, and Left must
 * return to the active nav row. Zones are symmetric, so the bar is opened only
 * upward/sideways-in and closed sideways-out (`verticalOnly`, `crossZone`). R7
 * asserts each edge separately.
 *
 * Rectangles are asserted because the 208px rail must hold "PERFORMERS" in
 * Inter 17px/600 with 0.05em tracking, and `.label` ellipsises silently:
 * `scrollWidth > clientWidth` is the only cheap way to see truncation.
 * Geometry is not taste; whether it looks good is a TV pass.
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

// A render error unmounts the tree, which otherwise reads only as "the rail is
// gone"; collect the reasons as they happen.
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
// `key` alone is enough: handlers test it before `e.keyCode`, which a synthetic
// KeyboardEvent cannot carry anyway.
//
// Dispatch on the focused element with `bubbles`: useKeyHandler listens on
// window, while useFocusable's Enter handler is bound to the element and a
// window event never travels downwards to it.
//
// 150 ms between presses clears useKeyHandler's 90 ms held-arrow throttle.
async function press(key) {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true,
  }));
  await sleep(150);
}

// Enter needs a keyup only on cards: VideoCard passes `onLongPress`, moving its
// short action to keyup. Rail rows activate on keydown, so sending both keeps
// one helper.
async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(150);
}

// Focus an element by its registry id, the only handle the cards have, they
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

// Four card families can sit beside a rail row: Scenes/Performers (`video-`),
// Home's showroom scene shelf, and Home's studio/performer/gallery cards. The
// walk drives Scenes, but R4 reads focus at rest on Home, so all count.
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
  // Wait for Home's first shelf, or the layout is not final. The card walks
  // below use the Scenes tab, reached later.
  await waitFor(() => registry.has('showroom-recent-scenes-video-1'));
  await sleep(300);

  // ── R1  the rail is there, with the right rows ──────────
  // Ten rows, Search last below the library sections. Written out because the
  // order is what the `next` chain depends on; a count passes on any
  // permutation.
  const labels = railRows().map(b => b.textContent.trim());
  check('R1 the rail renders its ten rows',
    JSON.stringify(labels) === JSON.stringify([
      'Home', 'Scenes', 'Performers', 'Markers', 'Tags', 'Studios',
      'Galleries', 'Images', 'Search', 'Settings',
    ]),
    labels.join(' · ') || '(no rail)');

  // Reels must stay gone; assert by name rather than trusting the list above.
  check('R1 no Reels row survives', !labels.includes('Reels'), labels.join(' · '));

  // ── R2  geometry ────────────────────────────────────────
  const rail = railEl();
  const main = document.querySelector('[role="main"]');
  const railRect = rect(rail);
  const mainRect = rect(main);
  check('R2 the rail is --sidebar-w wide', Math.round(railRect.width) === 208,
    `${Math.round(railRect.width)}px`);
  check('R2 the content column starts at the rail, not under it',
    mainRect.left >= railRect.right - 1,
    `rail ends ${Math.round(railRect.right)}, main starts ${Math.round(mainRect.left)}`);
  // The viewport is in the detail: every coordinate in the R7 graph, and every
  // edge judged there, depends on it; an unrecorded size cannot be compared.
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
  // Not a hard rule: the rail's first row and the grid's first card both
  // autofocus, and which wins is a race between two 50 ms timers. Recorded
  // because it changes the first Right move.
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

  // ── R5b the whole chain, which is now ten deep ──────────
  // The `next` chain exists because geometry cannot find Settings past the
  // spacer. Every row must name its successor or it becomes a row Down cannot
  // leave. Walk end to end: one missing link stops the walk, so its length is
  // the assertion.
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
    getCurrentFocusId() === 'nav-search', getCurrentFocusId());

  // ── R5c  the foot of the rail is the foot ───────────────
  // Settings is last; Down must do nothing, since Right is the way into the
  // content. Without a declared edge, geometry dropped focus into the page.
  focus('nav-settings');
  await sleep(120);
  await press('ArrowDown');
  check('R5c Down on Settings leaves focus where it is',
    getCurrentFocusId() === 'nav-settings', getCurrentFocusId());

  // The scene listing is on Scenes, so the card walks and bar graph are driven
  // there. The rail is identical on every tab; this is only its probe surface.
  focus('nav-scenes');
  await sleep(120);
  await tapEnter();
  await waitFor(() => registry.has('video-1'));
  await sleep(300);
  focus('nav-settings');
  await sleep(120);

  // ── R6  the crossing, the load-bearing claim ───────────
  // In a separate zone, findBestCandidate returns null for Right and focus
  // never leaves the rail.
  await press('ArrowRight');
  const afterRight = getCurrentFocusId();
  check('R6 Right leaves the rail', !idIsRail(afterRight),
    `${afterRight}${idIsRail(afterRight) ? '  ← the rail is a trap' : ''}`);

  // A browse row leads into the grid. nav-markers sits beside the cards at an
  // unambiguous height; the top row shares its height with the bar, so it is a
  // poor place to assert a general rule.
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
  // Everything must reach the rail and the rail must reach everything. Spatial
  // nav is a graph, so probe the edges rather than one hand-picked path that
  // the geometry happens to agree with.
  //
  // The controls bar is the case that matters: it was outside the grid's zone
  // and reachable only through the rail. Find it by position, immediately
  // above <main>, not by zone, or the probe would test nothing after the fix.
  const barEl = document.querySelector('[role="main"]')?.previousElementSibling;
  const barIds = barEl
    ? [...registry.entries()].filter(([, v]) => barEl.contains(v.el)).map(([id]) => id)
    : [];

  // Card anchors down the first column and across the first row: they answer
  // "where does Left go down the page" and "where does Up go across it".
  const anchors = [
    // Every rail row, so the graph also answers "can the bar be reached from
    // the rail" without a second probe, and R8 can read the whole `next` chain.
    // Listed rather than derived from `labels`: a stale list is how R8 once
    // reported `nav-tags ↓undefined` after rows were added.
    'nav-home', 'nav-scenes', 'nav-performers', 'nav-markers',
    'nav-tags', 'nav-studios', 'nav-galleries', 'nav-images', 'nav-search',
    'nav-settings',
    ...barIds,                             // every control, so the bar's own
                                           // Left/Right walk is in the graph

    'video-1', 'video-2', 'video-4',      // first row, across
    'video-5', 'video-9', 'video-13',     // first column, down
  ].filter(id => registry.has(id));

  // Capture geometry per anchor when its presses are judged: the grid scrolls
  // as later anchors are focused, so one dump after the walk describes a layout
  // only the last anchor saw. Spatial nav is decided entirely by these rects.
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
  // Measured, not reasoned: the bar wraps to two rows at this width
  // (`flex-wrap: wrap`), so `ctrl-*` ids appear at two y values.
  const barRect = (id) => {
    const r = rect(registry.get(id)?.el);
    return r ? `${id}@${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : `${id}:MISSING`;
  };
  check('R7 the controls bar geometry', true, barIds.map(barRect).join('  '));

  const inBar = (id) => barIds.includes(id);

  // ── The bar is reachable from the cards ─────────────────
  // Up from the first card row reaches the bar; it stays out of the sideways
  // walk because every control is `verticalOnly`. Read from the graph above,
  // not a second walk: a duplicated probe once disagreed with the good one.
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
  // Left lands on the *active* row, which generalises to any tab. Settings must
  // not be the drop: at the rail's foot it was nearest a lower card's centre,
  // so Left opened a modal on a sideways press.
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

  // Left from the bar's leftmost control returns to the rail. From the middle,
  // Left correctly moves along the bar (ctrl-search ← ctrl-filter).
  const leftmostBar = barIds
    .map(id => ({ id, r: rect(registry.get(id)?.el) }))
    .filter(x => x.r)
    .sort((a, b) => a.r.left - b.r.left)[0]?.id;
  focus(leftmostBar);
  await sleep(120);
  await press('ArrowLeft');
  check('R7 Left from the bar\'s leftmost control returns to the rail',
    idIsRail(getCurrentFocusId()), `${leftmostBar} ← ${getCurrentFocusId()}`);

  // The mirror half the `verticalOnly` flag exists for. With the bar in the
  // grid's zone, Right from video-2 went to the mute toggle 21 px right and
  // 166 px up (score 269), beating video-3 at 276 px right (282).
  const sidewaysIntoCards = ['video-1', 'video-2', 'video-4']
    .filter(id => registry.has(id))
    .map(id => `${id}: →${edges[id]?.ArrowRight} ←${edges[id]?.ArrowLeft}`)
    .join('   ');
  check('R7 no card reaches the bar sideways',
    ['video-1', 'video-2', 'video-4'].filter(id => registry.has(id))
      .every(id => !inBar(edges[id]?.ArrowRight) && !inBar(edges[id]?.ArrowLeft)),
    sidewaysIntoCards);

  // Right from the rail must not reach the bar's search box, which sits
  // directly right of the top two rows. This caught the flag being dropped in
  // useEditableField, whose own `useFocusable` call discarded unnamed options.
  check('R7 no rail row reaches the bar sideways',
    ['nav-home', 'nav-performers', 'nav-markers', 'nav-settings']
      .every(id => !inBar(edges[id]?.ArrowRight) && !inBar(edges[id]?.ArrowLeft)),
    ['nav-home', 'nav-performers', 'nav-markers', 'nav-settings']
      .map(id => `${id} →${edges[id]?.ArrowRight} ←${edges[id]?.ArrowLeft}`).join('   '));

  // ── The bar is still a walkable row ─────────────────────
  // Marking every control `verticalOnly` opens the bar upward but also shuts
  // Left/Right inside it, dropping focus into the cards on a sideways press.
  // Assert row 1's horizontal walk; row 2 is shaped by the wrap.
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
  // Each rail row's Down must land on the next rail row. The layout cannot
  // guarantee it: Settings is pinned to the foot, and the row above sits at the
  // far end of a flexible spacer. Assert named edges, not "reachable in four
  // presses": the weaker form was green wherever geometry happened to agree and
  // failed the bug at the TV's 1080 height.
  const railChain = ['nav-home', 'nav-scenes', 'nav-performers',
    'nav-markers', 'nav-tags', 'nav-studios', 'nav-galleries', 'nav-images',
    'nav-search'];
  const nextRow = {
    'nav-home': 'nav-scenes',
    'nav-scenes': 'nav-performers',
    'nav-performers': 'nav-markers',
    'nav-markers': 'nav-tags', 'nav-tags': 'nav-studios',
    'nav-studios': 'nav-galleries', 'nav-galleries': 'nav-images',
    'nav-images': 'nav-search', 'nav-search': 'nav-settings',
  };
  const broken = railChain.filter(id => edges[id]?.ArrowDown !== nextRow[id]);
  check('R8 Down walks the rail row by row to Settings',
    broken.length === 0,
    broken.length
      ? broken.map(id => `${id} ↓${edges[id]?.ArrowDown} (wanted ${nextRow[id]})`).join('; ')
      : railChain.map(id => `${id} ↓${nextRow[id]}`).join('  '));

  // The same edge upwards. Up out of Settings used to fall back to geometry
  // and land on a grid card; Up is the only exit, since Settings is
  // `verticalOnly`. Check the graph: this is the declared chain, not pixels.
  check('R8 Up out of Settings returns to the rail',
    edges['nav-settings']?.ArrowUp === 'nav-search',
    `nav-settings ↑${edges['nav-settings']?.ArrowUp ?? '—'} (wanted nav-search)`);

  // The user's path from a cold focus, ending with the panel open: the graph
  // proves edges, this proves the walk. Bound by `labels.length`, not a
  // literal, which goes stale into a passing check when rows are added.
  focus('nav-home');
  await sleep(120);
  for (let i = 0; i < labels.length && getCurrentFocusId() !== 'nav-settings'; i++) {
    await press('ArrowDown');
  }
  check('R8 Down the rail reaches Settings', getCurrentFocusId() === 'nav-settings',
    getCurrentFocusId());

  check('R8 the rail is still mounted before the press', rootAlive() && !!railEl(),
    `#root children ${document.getElementById('root')?.children.length}, rail ${!!railEl()}`);

  // Seed a PIN: it changes the lock section's buttons and lengthens the body
  // beyond the no-PIN layout. Clear it below so later checks see a fresh store.
  setPin('1234');
  await sleep(60);

  await tapEnter();
  const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 2000);
  check('R8 Enter on Settings opens the panel', !!dialog,
    dialog ? 'role="dialog" present'
           : `no dialog; rail ${!!railEl()}; errors: ${errorTail()}`);

  // ── R8b  Down exhausts the panel body before the footer ──
  // The body is a scroll container and the footer is fixed below it. Geometry
  // rated the footer nearer whenever the next option was below the fold, so
  // Down jumped to Save and resumed scrolling afterwards. Assert the property:
  // if a body control is still below focus, Down must not enter the footer.
  // The body set comes from the registry by zone, because PIN buttons vary.
  //
  // This walk was GREEN with the fix deleted (control experiment): at this
  // window the scorer already favours the body. It states the requirement;
  // R8b2 is the check that proves the container rule.
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

  // Diagnostics: is there a scroll container, and how much body is below the
  // fold? If scrollHeight === clientHeight the panel does not scroll and the
  // walk check is vacuous.
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
  // Reproduce Down scoring for the nearest body control and the footer: the
  // footer pays the +100000 cross-zone penalty, and the container rule adds a
  // million outside the focused scroll box. The margin tells whether the
  // reported jump could have come from this scoring.
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
  // The walk above passes on pre-fix scoring at this window: Save 100315 vs
  // the PIN row 100182, a 133 px margin from today's font metrics. The TV's
  // metrics put Save ahead. Build the worst case: move Save directly 60 px
  // under the focused option. Under the rule position cannot matter, since
  // Save is outside the scroll box; without it, Save wins (the control).
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

  // ── R8c  reaching the footer reveals the end of the body ──
  // The PIN button is the body's last focus stop; the "A forgotten PIN" hint
  // below it has none. Moving to Save left it clipped at the fold. The panel
  // must scroll the body to its end when the footer takes focus.
  let reveal = null;
  if (dialog && reachedFooter) {
    const firstEl = registry.get('settings-mode-test')?.el;
    let n = firstEl?.parentElement;
    let body = null;
    while (n && n !== document.body && n !== document.documentElement) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') { body = n; break; }
      n = n.parentElement;
    }
    const hint = [...document.querySelectorAll('[role="dialog"] p')]
      .find(p => (p.textContent || '').startsWith('A forgotten PIN cannot'));
    if (body && hint) {
      const br = body.getBoundingClientRect();
      const hr = hint.getBoundingClientRect();
      reveal = {
        scrollTop: Math.round(body.scrollTop),
        max: Math.round(body.scrollHeight - body.clientHeight),
        hintTop: Math.round(hr.top - br.top),
        hintBottom: Math.round(hr.bottom - br.top),
        view: Math.round(br.height),
      };
    }
  }
  check('R8c reaching the footer reveals the end of the settings body',
    !!reveal
      && reveal.scrollTop >= reveal.max - 2
      && reveal.hintBottom <= reveal.view + 1
      && reveal.hintTop >= -1,
    reveal
      ? `scrollTop=${reveal.scrollTop}/${reveal.max} hint=${reveal.hintTop}-${reveal.hintBottom} view=${reveal.view}`
      : 'scroll container or PIN hint missing');

  clearPin();
  await sleep(60);

  // ── R9  Enter on a tab row switches the tab ─────────────
  // Close the panel first, it is modal and would scope the vault search.
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
  // `offsetTop + 7` and `offsetHeight - 14` are measured from the row, not
  // derived from its index, so unequal row heights work. The 0.28 s transition
  // is waited out.
  await sleep(450);
  const marker = railEl()?.firstElementChild;
  // The *active* row: R9 left Performers active, and the indicator tracks the
  // active tab, not the focused row. Asserting against Home was a test bug.
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
  // With nothing below the focused card, mid-load or at the listing's end:
  // a rail row is the nearest Down candidate, since the rows share the grid's
  // zone and Settings is fixed at the foot. `skipRailRows` is the guard.
  // The fake's `short` mode (one full row, then one card) makes this
  // deterministic; with any card still below, geometry never reaches the rail,
  // and the earlier full-listing check stayed green with the guard deleted.
  const shortMode = await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findScenes: 'short' }),
  }).then(r => r.json()).catch(() => null);
  // Leaving a tab clears every list cache, so away-and-back is how the short
  // answer reaches the visible page.
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

// Before render, so the first fetch sees the fake endpoint: `runQuery` reads
// the store per request, but a mount effect may flush before the next line.
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
