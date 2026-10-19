/**
 * roworder-entry.jsx — the D-pad row-order audit of every screen.
 *
 * The claim is narrow and geometric: on every screen, Left and Right move
 * focus through the items of one visual line, in the order the line is read.
 * It does not test Up/Down, which is about *between* rows (and is already
 * covered by the rail's declared edges in rail-entry) — it tests that a row,
 * once entered, is a row.
 *
 * Why this needs a driver and not reading. The navigator scores candidates
 * from rectangles, so row order is usually correct *by construction* — and
 * usually is exactly the word that hides the exceptions. A control that is
 * visually in a row but registered in another zone is skipped sideways; a
 * wrapped action row's second line is to the left of where the first ends; a
 * card that is `verticalOnly` is an invisible hole in a row. None of those
 * throws, and each looks fine on a static screen. Walking the rows is the only
 * way to see them.
 *
 * How a line is found. Visible registry entries (the navigator skips
 * `offsetParent === null` and disabled elements, so this does too) are
 * clustered by vertical overlap: two entries share a line when their rects
 * overlap by more than half the shorter one. That is deliberately not "same
 * top", because a chip and a button on one row can have different heights and
 * still be one line to the eye.
 *
 * The exceptions the audit knows about, and why they are not failures:
 *
 *  - A declared edge (`nextId[direction]`) replaces the geometric search by
 *    design. The rail's Settings row is the case: it is six hundred pixels
 *    below the tabs and the geometry confidently picks a grid card. The walk
 *    expects the declared target, so a *broken* declaration still fails.
 *  - A self-referencing declaration is a blocked direction (Down on Settings);
 *    focus must not move.
 *  - A wrapped flex row is one logical line rendered as several physical
 *    lines, and Right at the end of one continues at the left edge of the
 *    next. Expected order here is reading order: the next physical line's
 *    leftmost item. Grids are not wrapped rows and deliberately stop at the
 *    edge of their line.
 *  - Entries that are `verticalOnly` cannot be entered sideways; they are
 *    left out of the participant list rather than counted as holes.
 *  - Lines with fewer than two participants are not rows to walk. That is the
 *    rail (one item per line), a heading with a single button, and any
 *    section that has only one focusable.
 *
 * What this cannot tell you: whether a row *should* have a different order.
 * It verifies the D-pad against the layout on screen; if the layout itself is
 * wrong (a card in the wrong column), both agree and the walk passes.
 *
 * Scope: the classic listings' first visible lines, the showroom shelves, both
 * detail pages, Settings and the exit prompt. Carousel and list modes are not
 * walked — a carousel is a single line by construction, and a list's rows have
 * one focusable each — and neither are dropdowns or the filter builder, whose
 * items are one column inside a dialog. Those were triaged, not forgotten;
 * see the notes below.
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

const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});
const errorTail = () => (errors.length ? errors.slice(-2).join(' | ') : 'none');

async function waitFor(pred, ms = 6000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

// The navigator throttles held keys to 90 ms; a driver that outpaces it drops
// presses and reads a stationary focus as a wrong answer. 150 ms is that
// throttle plus room for the focus event to land.
async function press(key) {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await sleep(150);
}

async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(300);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};

// ── Reading the screen ─────────────────────────────────────
// The navigator confines itself to the nearest dialog when one is open, so the
// audit must too — otherwise a settings row would be compared against cards
// behind the panel.
function activeScope() {
  return document.querySelector('[role="dialog"]') || document.querySelector('[data-focus-trap]');
}

function snapshot() {
  const scope = activeScope();
  const items = [];
  registry.forEach((entry, id) => {
    const el = entry?.el;
    if (!el || !el.offsetParent || el.disabled) return;
    if (scope && !scope.contains(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    items.push({ id, entry, el, r });
  });
  return items;
}

// Vertical-overlap clustering. Greedy over top-sorted entries, extending the
// line's union as it goes: two entries join when they overlap by more than
// half of the shorter one, which is "same line to the eye" rather than "same
// top to the pixel".
function linesOf(items) {
  const sorted = [...items].sort((a, b) => a.r.top - b.r.top);
  const lines = [];
  for (const it of sorted) {
    const line = lines[lines.length - 1];
    if (line) {
      const overlap = Math.min(line.bottom, it.r.bottom) - Math.max(line.top, it.r.top);
      if (overlap > 0.5 * Math.min(line.bottom - line.top, it.r.height)) {
        line.items.push(it);
        line.top = Math.min(line.top, it.r.top);
        line.bottom = Math.max(line.bottom, it.r.bottom);
        continue;
      }
    }
    lines.push({ top: it.r.top, bottom: it.r.bottom, items: [it] });
  }
  return lines;
}

const inViewport = (line) => line.bottom > 0 && line.top < window.innerHeight;

function wrapContainerOf(el) {
  let n = el?.parentElement;
  while (n && n !== document.body && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'flex' && (cs.flexWrap === 'wrap' || cs.flexWrap === 'wrap-reverse')) {
      return n;
    }
    n = n.parentElement;
  }
  return null;
}

function declaredNext(cur, dir) {
  const forced = cur.entry.nextId?.[dir];
  if (!forced) return undefined;
  if (forced === cur.id) return null;             // a blocked direction
  const target = registry.get(forced);
  return target?.el && target.el.offsetParent && !target.el.disabled ? forced : undefined;
}

// Reading order inside a wrapped row: the next *physical* line's leftmost (or,
// going left, rightmost) item. Derived from the visual lines rather than from
// the navigator's score, so the driver is checking the layout and not checking
// the algorithm against itself.
function wrapNext(cur, dir, items) {
  const container = wrapContainerOf(cur.el);
  if (!container) return null;
  const inContainer = items.filter(i => container.contains(i.el)
    && i.entry.zone === cur.entry.zone && !i.entry.verticalOnly);
  const containerLines = linesOf(inContainer).sort((a, b) => a.top - b.top);
  const idx = containerLines.findIndex(l => l.items.some(i => i.id === cur.id));
  if (idx < 0) return null;
  const next = containerLines[dir === 'right' ? idx + 1 : idx - 1];
  if (!next) return null;
  const candidates = next.items
    .filter(i => !i.entry.verticalOnly)
    .sort((a, b) => (dir === 'right' ? a.r.left - b.r.left : b.r.left - a.r.left));
  return candidates[0]?.id ?? null;
}

function describe(fails) {
  return fails.length
    ? `${fails.slice(0, 4).join(' | ')}${fails.length > 4 ? ` | (+${fails.length - 4} more)` : ''}`
    : '';
}

// ── The walk ───────────────────────────────────────────────
async function walkLine(pts, key, fails, items) {
  const dir = key === 'ArrowRight' ? 'right' : 'left';
  for (let i = 0; i < pts.length - 1; i++) {
    const cur = pts[i];
    const want = pts[i + 1].id;
    const declared = declaredNext(cur, dir);
    // Reading-order continuation applies only at the END of a physical line.
    // Asking for it mid-line is how the first version of this check reported
    // the scene detail's perfectly good action row as broken: from Play it
    // expected the second line's first item instead of the rating stepper
    // beside it.
    let expected = want;
    if (declared === null) expected = cur.id;
    else if (typeof declared === 'string') expected = declared;
    else if (i === pts.length - 1) expected = wrapNext(cur, dir, items) ?? want;

    if (!focus(cur.id)) {
      fails.push(`${cur.id} not focusable`);
      continue;
    }
    await press(key);
    const got = getCurrentFocusId();
    if (got !== expected) {
      // Include the geometry that produced the ordering: a wrapped row and a
      // mis-sorted row look identical in the id alone.
      const box = (i) => {
        const p = pts.find(q => q.id === i);
        return p ? `${i}@(${Math.round(p.r.left)},${Math.round(p.r.top)},${Math.round(p.r.width)}x${Math.round(p.r.height)})` : i;
      };
      fails.push(`${box(cur.id)} ${dir}→ ${got ?? 'nothing'} (expected ${box(expected)}; order ${pts.map(p => p.id).join(',')})`);
      // Resynchronise on the expected item so one break does not paint the
      // rest of the row as a cascade of failures.
      focus(expected);
    }
  }
}

// Walk at most this many visible lines per screen: the audit is about the
// shape of a row, and the first few rows carry every card family and control
// type on a listing. The cap keeps the whole driver inside the runner's
// 100-second DONE window.
const MAX_LINES = 4;

// Every walkable row on screen: a visual line's members of one zone, left to
// right, with single-item lines dropped *before* the cap below. The rail is
// nine single-item lines down the left edge, and letting them spend the cap
// would leave the shelf beside them unaudited — which is exactly what the
// first run of this driver did.
function rowGroups(lines) {
  const groups = [];
  for (const line of lines) {
    // A line can span zones only where a cross-zone element was placed there
    // deliberately; the navigator refuses sideways moves across zones, so walk
    // one zone's members at a time.
    const byZone = new Map();
    for (const it of line.items) {
      const zone = it.entry.zone ?? '(none)';
      if (!byZone.has(zone)) byZone.set(zone, []);
      byZone.get(zone).push(it);
    }
    for (const members of byZone.values()) {
      const pts = members
        .filter(i => !i.entry.verticalOnly)
        .sort((a, b) => a.r.left - b.r.left);
      if (pts.length >= 2) groups.push(pts);
    }
  }
  return groups;
}

async function auditScreen(label) {
  await sleep(150);
  const items = snapshot();
  const lines = linesOf(items).filter(inViewport);
  const groups = rowGroups(lines).slice(0, MAX_LINES);
  const right = [];
  const left = [];
  const rows = groups.length;

  for (const pts of groups) {
    await walkLine(pts, 'ArrowRight', right, items);
    await walkLine([...pts].reverse(), 'ArrowLeft', left, items);
  }

  check(`${label}: rows walk left → right`, right.length === 0,
    `${rows} rows walked${right.length ? ` — ${describe(right)}` : ''}`);
  check(`${label}: rows walk right → left`, left.length === 0,
    `${rows} rows walked${left.length ? ` — ${describe(left)}` : ''}`);
  return rows;
}

// ── Navigation between screens ─────────────────────────────
async function switchTab(tab, prefix) {
  focus(`nav-${tab}`);
  await tapEnter();
  const ok = await waitFor(
    () => [...registry.keys()].some(k => k.startsWith(`${prefix}-`)), 8000);
  await sleep(350);
  return ok;
}

async function openDetail(prefix, sentinel) {
  focus(`${prefix}-1`);
  await tapEnter();
  const ok = await waitFor(() => registry.has(sentinel), 6000);
  await sleep(300);
  return ok;
}

async function back() {
  await press('Backspace');
  await sleep(400);
}

async function run() {
  setSettings({
    stashUrl: `http://127.0.0.1:${PORT}`,
    stashKey: 'harness',
    useMock: false,
    onboarded: 'live',
  });

  const mounted = await waitFor(() => registry.size > 0, 8000);
  check('the app mounted', mounted, errorTail());
  if (!mounted) return;

  // ── Home: five shelves, each one six-item line ──────────
  await waitFor(() => document.querySelectorAll('[data-showroom-row]').length >= 4, 8000);
  await sleep(400);
  await auditScreen('Home shelves');

  // ── Every listing tab, classic grid ─────────────────────
  // The classic mode is the default; the driver does not switch modes. The
  // controls bar and the first card rows are the two line shapes on a tab, and
  // both are walked.
  const TABS = [
    ['scenes', 'video'],
    ['performers', 'performer'],
    ['markers', 'marker'],
    ['tags', 'tag'],
    ['studios', 'studio'],
    ['galleries', 'gallery'],
    ['images', 'image'],
  ];
  for (const [tab, prefix] of TABS) {
    const ok = await switchTab(tab, prefix);
    check(`${tab}: tab loaded`, ok, errorTail());
    if (ok) await auditScreen(`${tab} classic`);
  }

  // ── Scene detail: the marker row and the action row ─────
  // Both are flex-wrap rows, and this is the screen the wrap rule exists for.
  const inScenes = await switchTab('scenes', 'video');
  if (inScenes && await openDetail('video', 'scene-play')) {
    await auditScreen('scene detail');
    await back();
  } else {
    check('scene detail opened', false, errorTail());
  }

  // ── Performer detail: controls bar and scene rows ───────
  const inPerformers = await switchTab('performers', 'performer');
  if (inPerformers && await openDetail('performer', 'detail-back')) {
    await auditScreen('performer detail');
    await back();
  } else {
    check('performer detail opened', false, errorTail());
  }

  // ── Settings ────────────────────────────────────────────
  focus('nav-settings');
  await tapEnter();
  const settingsOpen = await waitFor(
    () => !!document.querySelector('[role="dialog"][aria-label="Settings"]'), 4000);
  await sleep(400);
  check('settings opened', settingsOpen, errorTail());
  if (settingsOpen) {
    await auditScreen('settings');
    await back();
  }

  // ── Exit prompt ─────────────────────────────────────────
  // Back at a top-level tab. Its two buttons are the only row; the rail and
  // grid behind it are out of scope and the snapshot filter enforces that.
  await back();
  const exitOpen = await waitFor(
    () => !!document.querySelector('[role="dialog"][aria-label="Exit confirmation"]'), 4000);
  check('exit prompt opened', exitOpen, errorTail());
  if (exitOpen) {
    await auditScreen('exit prompt');
    focus('exit-cancel');
    await tapEnter();
  }

  check('no uncaught error during the run', errors.length === 0, errorTail());

  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

document.body.style.margin = '0';
createRoot(document.getElementById('root')).render(<App />);
sleep(400).then(run).catch(async (e) => {
  check('driver completed', false, String((e && e.stack) || e));
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  }).catch(() => {});
  await fetch('/done', { method: 'POST' }).catch(() => {});
});
