/**
 * Headless driver for the read-only Tag/Studio Info sheet.
 *
 * Mounts the real App: the sheet is opened from a card's long-press menu, and
 * the Back trip returns to that card, so nothing here can be tested without
 * the listing behind it. The fake server carries every field the listing
 * omits, with VERIFY strings and a description long enough to overflow the
 * 78vh panel.
 *
 *   I1  a tag card's menu offers Info and View scenes; Info opens the sheet
 *       with the detail answer merged over the card, the hierarchy listed and
 *       the narrow query proven on the wire.
 *   I2  a studio sheet shows its rating, parent and sub-studios.
 *   I3  a failed and a deleted answer each render their own line, and the card
 *       stays readable.
 *   I4  Up/Down scroll the panel without moving focus; Back closes it, and
 *       Right/Left walk the count pills.
 *   I5  the menu's View scenes row still applies the tag filter.
 *   I6  a tag's counts open the listings behind them, with Back to the card.
 *   I7  a studio's counts do the same; its group count is not a stop.
 *   I8  a count opened from inside a filtered listing keeps it: each Back
 *       unwinds one level and restores the filter the level had.
 *
 * The panel and the counts are the only focusable surfaces in the dialog.
 * Arrow scroll is the trap: the global key handler would otherwise move the
 * D-pad to a card behind the sheet and cancel the browser's own scroll with
 * its preventDefault.
 */

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
const getJSON = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();
const clearLogs = () => fetch(`http://127.0.0.1:${PORT}/clear`, { method: 'POST' });
const setMode = (key, value) => fetch(`http://127.0.0.1:${PORT}/mode`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ [key]: value }),
});

const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});
const errorTail = () => (errors.length ? errors.slice(-2).join(' | ') : 'none');

async function waitFor(pred, ms = 8000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

async function waitForAsync(pred, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  let ok = false;
  while (Date.now() < end) {
    try { ok = await pred(); } catch { ok = false; }
    if (ok) return true;
    await sleep(step);
  }
  return ok;
}

const active = () => document.activeElement;
function press(key, keyCode) {
  (active() || document.body).dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}
function release(key, keyCode) {
  (active() || document.body).dispatchEvent(new KeyboardEvent('keyup', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}
async function tapEnter() {
  press('Enter', 13);
  await sleep(40);
  release('Enter', 13);
  await sleep(200);
}
async function pressBack() {
  press('Escape', 10009);
  await sleep(450);
}
async function holdEnter(ms = 950) {
  press('Enter', 13);
  await sleep(ms);
  release('Enter', 13);
  await sleep(300);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};
const live = (id) => {
  const el = registry.get(id)?.el;
  return !!el && document.contains(el);
};
const railActive = () =>
  [...(document.querySelector('nav[aria-label="Main navigation"]')?.querySelectorAll('button') ?? [])]
    .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || '(none)';

async function gotoTab(tab) {
  focus(`nav-${tab}`);
  await sleep(120);
  await tapEnter();
  await sleep(400);
}

const menuEl = () => document.querySelector('[role="dialog"][aria-label^="Actions for "]');
const sheetEl = () => document.querySelector('[role="dialog"][aria-label^="Info for "]');
// The sheet's only scrollable surface; the close button also carries
// tabindex="-1", hence the div qualifier.
const panelEl = () => sheetEl()?.querySelector('div[tabindex="-1"]') || null;
const sheetTitle = () => sheetEl()?.querySelector('h2')?.textContent || '';

/** Open a card's menu and choose one row. */
async function chooseMenuRow(cardId, rowId) {
  focus(cardId);
  await sleep(100);
  await holdEnter();
  const opened = await waitFor(() => !!menuEl(), 4000);
  const row = live(rowId);
  focus(rowId);
  await sleep(80);
  await tapEnter();
  return { opened, row };
}

async function finish() {
  await fetch(`http://127.0.0.1:${PORT}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch(`http://127.0.0.1:${PORT}/done`, { method: 'POST' });
}

// ── The run ─────────────────────────────────────────────────
async function run() {
  setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });
  await clearLogs();
  createRoot(document.getElementById('root')).render(<App />);

  await waitFor(() => live('nav-home'));
  await sleep(300);
  await gotoTab('tags');
  await waitFor(() => live('tag-1'));

  // ── I1: a tag's Info sheet ──────────────────────────────
  await clearLogs();
  const tagOpen = await chooseMenuRow('tag-1', 'menu-entity-info');
  const tagSheet = await waitFor(() => !!sheetEl(), 4000);
  const tagFetched = await waitForAsync(async () => (await getJSON('/taginfofetches'))
    .some(f => f.id === '1'), 4000);
  const tagText = sheetEl()?.textContent || '';
  check('I1 long-press offers Info, and choosing it opens the tag sheet',
    tagOpen.opened && tagOpen.row && tagSheet && tagFetched,
    `menu=${tagOpen.opened} row=${tagOpen.row} sheet=${tagSheet} fetch=${tagFetched} errors: ${errorTail()}`);
  check('I1 the detail answer is merged over the card',
    sheetTitle() === 'VERIFY tag info 1'
      && tagText.includes('★ Favourite')
      && tagText.includes('12 scenes') && tagText.includes('3 markers')
      && tagText.includes('4 images') && tagText.includes('5 galleries')
      && tagText.includes('6 performers') && tagText.includes('7 studios'),
    `title="${sheetTitle()}" counts=${['12 scenes', '3 markers', '4 images', '5 galleries',
      '6 performers', '7 studios'].filter(s => tagText.includes(s)).length}/6 `
    + `favourite=${tagText.includes('★ Favourite')}`);
  check('I1 the description, aliases and hierarchy are listed',
    tagText.includes('VERIFY tag info description.')
      && tagText.includes('VERIFY tag info alias one')
      && tagText.includes('VERIFY tag info alias two')
      && tagText.includes('Parent tags') && tagText.includes('VERIFY parent tag')
      && tagText.includes('Child tags') && tagText.includes('VERIFY child tag one')
      && tagText.includes('VERIFY child tag two'),
    `description=${tagText.includes('VERIFY tag info description.')} `
    + `aliases=${tagText.includes('VERIFY tag info alias one')} `
    + `parents=${tagText.includes('VERIFY parent tag')} children=${tagText.includes('VERIFY child tag two')}`);

  const tagFetch = (await getJSON('/taginfofetches')).find(f => f.id === '1');
  const tagQuery = tagFetch?.query || '';
  check('I1 the query asks for the fields the listing omits, and no image path',
    ['name', 'description', 'aliases', 'parents', 'children', 'scene_marker_count']
      .every(f => tagQuery.includes(f)) && !tagQuery.includes('image_path'),
    `missing=${['name', 'description', 'aliases', 'parents', 'children', 'scene_marker_count']
      .filter(f => !tagQuery.includes(f))} leaked=${tagQuery.includes('image_path')}`);
  check('I1 the sheet is the focused surface, and frames its own dialog',
    getCurrentFocusId() === 'entity-info-panel',
    `focus=${getCurrentFocusId()} label="${sheetEl()?.getAttribute('aria-label')}"`);

  // ── I4a: arrows scroll the panel, not the page behind it ──
  const panel = panelEl();
  const overflow = !!panel && panel.scrollHeight > panel.clientHeight;
  const before = panel?.scrollTop ?? -1;
  press('ArrowDown', 40);
  await sleep(350);
  const afterDown = panelEl()?.scrollTop ?? -1;
  const focusAfterDown = getCurrentFocusId();
  press('ArrowUp', 38);
  await sleep(350);
  const afterUp = panelEl()?.scrollTop ?? -1;
  check('I4 Down/Up scroll the sheet and leave the D-pad on it',
    overflow && afterDown > before && afterUp < afterDown
      && focusAfterDown === 'entity-info-panel'
      && getCurrentFocusId() === 'entity-info-panel',
    `overflow=${overflow} scroll=${before}→${afterDown}→${afterUp} `
    + `focus=${focusAfterDown}/${getCurrentFocusId()}`);

  // ── I4b: Right/Left walk into the counts and along them ──
  // The panel is the only autoFocus; it declares its sides into the first
  // count, and the counts carry their own chain, so the row works even when
  // it wraps.
  press('ArrowRight', 39);
  await sleep(250);
  const firstCount = getCurrentFocusId();
  press('ArrowRight', 39);
  await sleep(250);
  const secondCount = getCurrentFocusId();
  press('ArrowLeft', 37);
  await sleep(250);
  const backToFirst = getCurrentFocusId();
  check('I4b Right enters the counts and walks the row, Left walks back',
    firstCount === 'entity-count-scenes' && secondCount === 'entity-count-markers'
      && backToFirst === 'entity-count-scenes',
    `right=${firstCount} right=${secondCount} left=${backToFirst}`);

  // The panel's keydown owns Up/Down wherever the cursor is inside it: a count
  // is a button, not a replacement for scrolling a long sheet.
  const scrollAt = panelEl()?.scrollTop ?? -1;
  press('ArrowDown', 40);
  await sleep(300);
  const scrolledUnderCount = (panelEl()?.scrollTop ?? -1) > scrollAt;
  check('I4b Down scrolls the sheet with the cursor still on a count',
    scrolledUnderCount && getCurrentFocusId() === 'entity-count-scenes',
    `scroll=${scrollAt}→${panelEl()?.scrollTop} focus=${getCurrentFocusId()}`);

  await pressBack();
  const tagClosed = await waitFor(() => !sheetEl(), 3000);
  const tagRestored = await waitFor(() => getCurrentFocusId() === 'tag-1', 3000);
  check('I4 Back closes the sheet and returns focus to the card',
    tagClosed && tagRestored && !menuEl(),
    `closed=${tagClosed} focus=${getCurrentFocusId()} menu=${!!menuEl()}`);

  // ── I6: a tag's counts open the listings behind them ──────
  await clearLogs();
  await chooseMenuRow('tag-1', 'menu-entity-info');
  const tagCountsSheet = await waitFor(() => !!sheetEl(), 4000);
  const tagCountIds = [...registry.keys()]
    .filter(id => id.startsWith('entity-count-'));
  check('I6 each of a tag\'s six counts is a D-pad stop',
    tagCountsSheet && tagCountIds.length === 6
      && ['scenes', 'markers', 'images', 'galleries', 'performers', 'studios']
        .every(t => tagCountIds.includes(`entity-count-${t}`)),
    `ids=[${tagCountIds.join(',')}]`);

  focus('entity-count-performers');
  await sleep(80);
  await tapEnter();
  const onPerformers = await waitFor(() => railActive().toLowerCase() === 'performers', 5000);
  const performerFiltered = await waitForAsync(async () => (await getJSON('/requests'))
    .some(r => r.performer_filter?.tags?.value?.[0] === '1'), 4000);
  check('I6 the performer count opens Performers filtered to the tag',
    onPerformers && performerFiltered && !sheetEl(),
    `rail=${railActive()} filtered=${performerFiltered} sheet=${!!sheetEl()}`);
  await pressBack();
  const backToTag = await waitFor(
    () => railActive().toLowerCase() === 'tags' && getCurrentFocusId() === 'tag-1', 8000);
  check('I6 ...and Back returns to the tag card', backToTag,
    `rail=${railActive()} focus=${getCurrentFocusId()}`);

  // The marker tab's criterion field is named differently (`scene_marker_filter`),
  // so it is the one target the other five do not stand in for.
  await setMode('markers', 'paged');
  await chooseMenuRow('tag-1', 'menu-entity-info');
  await waitFor(() => !!sheetEl(), 4000);
  focus('entity-count-markers');
  await sleep(80);
  await tapEnter();
  const onMarkers = await waitFor(() => railActive().toLowerCase() === 'markers', 5000);
  const markerFiltered = await waitForAsync(async () => (await getJSON('/requests'))
    .some(r => r.scene_marker_filter?.tags?.value?.[0] === '1'), 4000);
  check('I6 the marker count opens Markers with the marker tag filter',
    onMarkers && markerFiltered,
    `rail=${railActive()} filtered=${markerFiltered}`);
  await setMode('markers', 'ok');
  await pressBack();
  await waitFor(() => railActive().toLowerCase() === 'tags' && getCurrentFocusId() === 'tag-1', 8000);

  // ── I2: a studio's sheet ────────────────────────────────
  await gotoTab('studios');
  await waitFor(() => live('studio-4'));
  await clearLogs();
  const studioOpen = await chooseMenuRow('studio-4', 'menu-entity-info');
  const studioSheet = await waitFor(() => !!sheetEl(), 4000);
  const studioFetched = await waitForAsync(async () => (await getJSON('/studioinfofetches'))
    .some(f => f.id === '4'), 4000);
  const studioText = sheetEl()?.textContent || '';
  check('I2 the studio sheet opens from the long-press menu',
    studioOpen.opened && studioOpen.row && studioSheet && studioFetched,
    `menu=${studioOpen.opened} sheet=${studioSheet} fetch=${studioFetched} errors: ${errorTail()}`);
  check('I2 the detail answer is merged over the card',
    sheetTitle() === 'VERIFY studio info 4'
      && studioText.includes('★ 8.5')
      && studioText.includes('21 scenes') && studioText.includes('22 images')
      && studioText.includes('23 galleries') && studioText.includes('24 performers')
      && studioText.includes('2 groups'),
    `title="${sheetTitle()}" rating85=${studioText.includes('★ 8.5')} `
    + `cardRating28=${studioText.includes('★ 2.8')} counts=${studioText.includes('2 groups')}`);
  check('I2 details, aliases and both studio directions are listed',
    studioText.includes('VERIFY studio info details.')
      && studioText.includes('VERIFY studio info alias')
      && studioText.includes('Parent studio') && studioText.includes('VERIFY parent studio')
      && studioText.includes('Sub-studios') && studioText.includes('VERIFY child studio'),
    `details=${studioText.includes('VERIFY studio info details.')} `
    + `parent=${studioText.includes('VERIFY parent studio')} `
    + `children=${studioText.includes('VERIFY child studio')}`);
  const studioQuery = (await getJSON('/studioinfofetches')).find(f => f.id === '4')?.query || '';
  check('I2 the studio query asks for details and the hierarchy',
    ['name', 'details', 'child_studios', 'parent_studio', 'rating100']
      .every(f => studioQuery.includes(f)) && !studioQuery.includes('image_path'),
    `missing=${['name', 'details', 'child_studios', 'parent_studio', 'rating100']
      .filter(f => !studioQuery.includes(f))} leaked=${studioQuery.includes('image_path')}`);

  await pressBack();
  const studioRestored = await waitFor(() => getCurrentFocusId() === 'studio-4', 3000);
  check('I2 Back returns to the studio card', studioRestored,
    `focus=${getCurrentFocusId()}`);

  // ── I7: a studio's counts filter by studio ───────────────
  await clearLogs();
  await chooseMenuRow('studio-4', 'menu-entity-info');
  await waitFor(() => !!sheetEl(), 4000);
  const studioCountIds = [...registry.keys()]
    .filter(id => id.startsWith('entity-count-'));
  // Groups are the one count with no tab behind it: it renders as a plain
  // span, so it is neither a stop nor an Enter target.
  const groupCount = [...document.querySelectorAll('[aria-label="Counts"] > *')]
    .find(el => el.textContent.trim() === '2 groups');
  check('I7 a studio offers its four filterable counts, groups stay a number',
    studioCountIds.length === 4
      && ['scenes', 'images', 'galleries', 'performers']
        .every(t => studioCountIds.includes(`entity-count-${t}`))
      && !studioCountIds.includes('entity-count-groups')
      && groupCount?.tagName === 'SPAN',
    `ids=[${studioCountIds.join(',')}] groups=${groupCount?.tagName}`);

  focus('entity-count-performers');
  await sleep(80);
  await tapEnter();
  const studioPerformers = await waitFor(() => railActive().toLowerCase() === 'performers', 5000);
  const studioFiltered = await waitForAsync(async () => (await getJSON('/requests'))
    .some(r => r.performer_filter?.studios?.value?.[0] === '4'), 4000);
  check('I7 the performer count opens Performers filtered to the studio',
    studioPerformers && studioFiltered && !sheetEl(),
    `rail=${railActive()} filtered=${studioFiltered} sheet=${!!sheetEl()}`);
  await pressBack();
  const backToStudio = await waitFor(
    () => railActive().toLowerCase() === 'studios' && getCurrentFocusId() === 'studio-4', 8000);
  check('I7 ...and Back returns to the studio card', backToStudio,
    `rail=${railActive()} focus=${getCurrentFocusId()}`);

  // ── I8: a count inside a filtered listing keeps that listing ──
  // Tags → tag 1's studios → studio 5's performers → Back must restore the
  // displaced tag filter, not a bare Studios listing, and Back again must
  // reach the tag card rather than the exit prompt.
  await gotoTab('tags');
  await waitFor(() => live('tag-1'));
  await chooseMenuRow('tag-1', 'menu-entity-info');
  await waitFor(() => !!sheetEl(), 4000);
  focus('entity-count-studios');
  await sleep(80);
  await tapEnter();
  const onFilteredStudios = await waitFor(() => railActive().toLowerCase() === 'studios', 5000);
  await waitFor(() => live('studio-5'));
  const studiosFiltered = await waitForAsync(async () => (await getJSON('/requests'))
    .some(r => r.studio_filter?.tags?.value?.[0] === '1'), 4000);
  check('I8 the tag\'s studio count opens Studios filtered to the tag',
    onFilteredStudios && studiosFiltered,
    `rail=${railActive()} filtered=${studiosFiltered}`);

  await chooseMenuRow('studio-5', 'menu-entity-info');
  await waitFor(() => !!sheetEl(), 4000);
  // A studio card does not carry performer_count; the detail answer does.
  await waitFor(() => live('entity-count-performers'), 4000);
  focus('entity-count-performers');
  await sleep(80);
  await tapEnter();
  const nestedPerformers = await waitFor(() => railActive().toLowerCase() === 'performers', 5000);
  const nestedFiltered = await waitForAsync(async () => (await getJSON('/requests'))
    .some(r => r.performer_filter?.studios?.value?.[0] === '5'), 4000);
  check('I8 a studio count inside that listing opens Performers too',
    nestedPerformers && nestedFiltered,
    `rail=${railActive()} filtered=${nestedFiltered}`);

  await clearLogs();
  await pressBack();
  const backToFilteredStudios = await waitFor(
    () => railActive().toLowerCase() === 'studios' && getCurrentFocusId() === 'studio-5', 8000);
  const restoredFilter = await waitForAsync(async () => (await getJSON('/requests'))
    .some(r => r.studio_filter?.tags?.value?.[0] === '1'), 4000);
  check('I8 Back restores the displaced tag filter, not a bare Studios listing',
    backToFilteredStudios && restoredFilter,
    `rail=${railActive()} focus=${getCurrentFocusId()} filtered=${restoredFilter}`);

  await pressBack();
  const backToTagCard = await waitFor(
    () => railActive().toLowerCase() === 'tags' && getCurrentFocusId() === 'tag-1', 8000);
  check('I8 Back again returns to the tag card, not the exit prompt',
    backToTagCard, `rail=${railActive()} focus=${getCurrentFocusId()}`);

  // ── I3: failure and deletion keep the card readable ─────
  await gotoTab('tags');
  await waitFor(() => live('tag-2'));

  await setMode('tagInfo', 'fail');
  const failOpen = await chooseMenuRow('tag-2', 'menu-entity-info');
  const failed = await waitFor(
    () => (sheetEl()?.textContent || '').includes("Couldn't load details."), 4000);
  // With no detail answer the sheet keeps the card's own name: that is what
  // the failure arm is for.
  check('I3 a failed detail query says so and still shows the card',
    failOpen.opened && failed && (sheetEl()?.textContent || '').includes('VERIFY tag 2'),
    `sheet=${!!sheetEl()} error=${failed} cardName=${(sheetEl()?.textContent || '').includes('VERIFY tag 2')}`);
  // The counts were on the card before the query ran, so the failure must not
  // take the sheet's only actions with it.
  const failCountIds = [...registry.keys()].filter(id => id.startsWith('entity-count-'));
  check('I3 a failed detail query leaves the card\'s counts actionable',
    failCountIds.length === 6, `ids=[${failCountIds.join(',')}]`);
  await pressBack();
  await waitFor(() => !sheetEl(), 3000);

  await setMode('tagInfo', 'missing');
  const missingOpen = await chooseMenuRow('tag-2', 'menu-entity-info');
  const missing = await waitFor(
    () => (sheetEl()?.textContent || '').includes('This tag is no longer on the server.'), 4000);
  check('I3 a deleted tag is named as deleted, not as an error',
    missingOpen.opened && missing, `sheet=${!!sheetEl()} missing=${missing} errors: ${errorTail()}`);
  await pressBack();
  await waitFor(() => !sheetEl(), 3000);
  await setMode('tagInfo', 'ok');

  // ── I5: View scenes still works from the menu ────────────
  await clearLogs();
  const scenesOpen = await chooseMenuRow('tag-2', 'menu-entity-scenes');
  const scenesArrived = await waitFor(() => railActive().toLowerCase() === 'scenes', 5000);
  // The log holds the variables as GraphQL receives them: ids, not labels.
  const filtered = await waitForAsync(async () => (await getJSON('/requests'))
    .some(r => r.scene_filter?.tags?.value?.[0] === '2'), 4000);
  check('I5 the menu\'s View scenes applies the tag filter',
    scenesOpen.opened && scenesOpen.row && scenesArrived && filtered,
    `menu=${scenesOpen.opened} row=${scenesOpen.row} rail=${railActive()} filtered=${filtered}`);
  await pressBack();
  const backToTags = await waitFor(
    () => railActive().toLowerCase() === 'tags' && getCurrentFocusId() === 'tag-2', 8000);
  check('I5 ...and Back returns to the tag card',
    backToTags, `rail=${railActive()} focus=${getCurrentFocusId()}`);

  check('I5 the whole run left no uncaught error', errors.length === 0, errorTail());
  await finish();
}

run().catch(async (e) => {
  results.push({
    name: 'HARNESS CRASHED',
    pass: false,
    detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
  });
  try { await finish(); } catch { /* nothing left to do */ }
});
