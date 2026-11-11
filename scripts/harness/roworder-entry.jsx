/**
 * roworder-entry.jsx: the D-pad row-order audit of every screen.
 *
 * The claim is geometric: Left and Right move focus through the items of one
 * visual line, in reading order. Up/Down (between rows) belongs to the rail's
 * declared edges in rail-entry.
 *
 * A driver is needed because the navigator scores rectangles, so row order is
 * usually correct by construction, and "usually" hides the exceptions: a
 * control registered in another zone is skipped sideways, and a `verticalOnly`
 * card is an invisible hole. Neither throws, and each looks fine on a static
 * screen.
 *
 * A line is visible registry entries clustered by vertical overlap (more than
 * half the shorter rect), not "same top": a chip and a button on one row can
 * differ in height. The navigator skips `offsetParent === null` and disabled
 * elements, and so does this.
 *
 * The known exceptions, none of them failures:
 *  - A declared edge (`nextId[direction]`) replaces the geometric search; the
 *    rail's Settings row is the case. The walk expects the declared target, so
 *    a broken declaration still fails. A self-reference means blocked.
 *  - Sideways past the end of a line is not checked here: the navigator moves
 *    geometrically and may leave the zone (the rail), which rail-entry covers.
 *  - `verticalOnly` entries are left out rather than counted as holes.
 *  - Lines with fewer than two participants are not rows to walk.
 *
 * It cannot tell you whether a row *should* be in another order: if the layout
 * is wrong, the D-pad agrees and the walk passes.
 *
 * Scope: classic listings' first visible lines, showroom shelves, both detail
 * pages, Settings and the exit prompt. Carousel and list modes are single-line
 * or one-focusable-per-row by construction, and dropdowns and the filter
 * builder are one column inside a dialog.
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

// The navigator throttles held keys to 90 ms; 150 ms is that throttle plus
// room for the focus event to land. Outpacing it reads a dropped press as a
// wrong answer.
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
// The navigator confines itself to the nearest dialog, so the audit must too:
// otherwise a settings row is compared against cards behind the panel.
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

// Greedy vertical-overlap clustering over top-sorted entries: two join when
// they overlap by more than half the shorter one, "same line to the eye",
// not "same top to the pixel".
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

function declaredNext(cur, dir) {
  const forced = cur.entry.nextId?.[dir];
  if (!forced) return undefined;
  if (forced === cur.id) return null;             // a blocked direction
  const target = registry.get(forced);
  return target?.el && target.el.offsetParent && !target.el.disabled ? forced : undefined;
}

function describe(fails) {
  return fails.length
    ? `${fails.slice(0, 4).join(' | ')}${fails.length > 4 ? ` | (+${fails.length - 4} more)` : ''}`
    : '';
}

// ── The walk ───────────────────────────────────────────────
async function walkLine(pts, key, fails) {
  const dir = key === 'ArrowRight' ? 'right' : 'left';
  // The last item has no neighbour in this line, and sideways focus past a row
  // end can leave the zone (the rail); rail-entry covers the rail's exits.
  for (let i = 0; i < pts.length - 1; i++) {
    const cur = pts[i];
    const want = pts[i + 1].id;
    const declared = declaredNext(cur, dir);
    let expected = want;
    if (declared === null) expected = cur.id;
    else if (typeof declared === 'string') expected = declared;

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
      // Resynchronise on the expected item so one break does not cascade.
      focus(expected);
    }
  }
}

// At most this many visible lines per screen: the first few rows carry every
// card family and control type, and the cap keeps the driver inside the
// runner's 100-second DONE window.
const MAX_LINES = 4;

// Walkable rows: one zone's members of a visual line, left to right, with
// single-item lines dropped before the cap. The rail is nine single-item lines
// down the left edge and would otherwise spend the whole cap.
function rowGroups(lines) {
  const groups = [];
  for (const line of lines) {
    // The navigator refuses sideways moves across zones, so walk one zone's
    // members at a time.
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
    await walkLine(pts, 'ArrowRight', right);
    await walkLine([...pts].reverse(), 'ArrowLeft', left);
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
