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
 *   I7  a studio's counts do the same; O and marker counts are plain numbers.
 *   I8  a count opened from inside a filtered listing keeps it: each Back
 *       unwinds one level and restores the filter the level had.
 *   I9  a group's sheet: synopsis, aliases, containing/sub-groups and tags.
 *   I10 a gallery's sheet: details, performers, tags, and counts derived from
 *       the fetched lists (Gallery exposes neither performer nor scene count).
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

// The Mode dropdown, driven like a remote: open it, pick the option.
async function driveMode(value) {
  if (!focus('ctrl-mode')) return false;
  await tapEnter();
  await sleep(250);
  if (!focus(`ctrl-mode-opt-${value}`)) return false;
  await tapEnter();
  await sleep(500);
  return true;
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
  const favBtn = () => registry.get('entity-action-favorite')?.el;
  check('I1 long-press offers Info, and choosing it opens the tag sheet',
    tagOpen.opened && tagOpen.row && tagSheet && tagFetched,
    `menu=${tagOpen.opened} row=${tagOpen.row} sheet=${tagSheet} fetch=${tagFetched} errors: ${errorTail()}`);
  // The favourite is a toggle now, so the old read-only pill must be gone:
  // one label, and the button is what carries the state.
  check('I1 the detail answer is merged over the card',
    sheetTitle() === 'VERIFY tag info 1'
      && favBtn()?.getAttribute('aria-pressed') === 'true'
      && (tagText.match(/Favourite/g) || []).length === 1
      && tagText.includes('12 scenes') && tagText.includes('3 markers')
      && tagText.includes('4 images') && tagText.includes('5 galleries')
      && tagText.includes('6 performers') && tagText.includes('7 studios'),
    `title="${sheetTitle()}" counts=${['12 scenes', '3 markers', '4 images', '5 galleries',
      '6 performers', '7 studios'].filter(s => tagText.includes(s)).length}/6 `
    + `favourite=${favBtn()?.getAttribute('aria-pressed')} `
    + `labels=${(tagText.match(/Favourite/g) || []).length}`);
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

  // ── I4b: the action row is the way in, the counts chain ──
  // The panel is the only autoFocus; it declares its sides into the first
  // action, each action drops to the first count, and the counts chain around
  // their own row with Up back to the actions.
  press('ArrowRight', 39);
  await sleep(250);
  const actionFocus = getCurrentFocusId();
  press('ArrowDown', 40);
  await sleep(250);
  const firstCount = getCurrentFocusId();
  press('ArrowRight', 39);
  await sleep(250);
  const secondCount = getCurrentFocusId();
  press('ArrowLeft', 37);
  await sleep(250);
  const backToFirst = getCurrentFocusId();
  press('ArrowUp', 38);
  await sleep(250);
  const backToAction = getCurrentFocusId();
  check('I4b Right enters the actions, Down the counts, Up returns',
    actionFocus === 'entity-action-favorite' && firstCount === 'entity-count-scenes'
      && secondCount === 'entity-count-markers' && backToFirst === 'entity-count-scenes'
      && backToAction === 'entity-action-favorite',
    `right=${actionFocus} down=${firstCount} right=${secondCount} `
    + `left=${backToFirst} up=${backToAction}`);

  // The panel scrolls only while it owns focus, so an arrow from an action has
  // to reach the D-pad chain rather than being swallowed by the scroller.
  const scrollAt = panelEl()?.scrollTop ?? -1;
  press('ArrowDown', 40);
  await sleep(300);
  check('I4b Down from an action moves focus and leaves the sheet unscrolled',
    getCurrentFocusId() === 'entity-count-scenes'
      && (panelEl()?.scrollTop ?? -1) === scrollAt,
    `focus=${getCurrentFocusId()} scroll=${scrollAt}→${panelEl()?.scrollTop}`);

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
  // GroupFilterType has a `studios` criterion, so the group count is a stop
  // too. O and marker counts stay plain numbers: no filter field takes them,
  // and a pill that opened a listing it cannot filter would be a lie.
  //
  // The marker count only exists on 0.32, where the detail query asks for it.
  // On 0.31 the fake server deliberately omits it, so the assertion must be
  // two-sided or a deleted `scene_marker_count` row would still pass.
  const { version: serverVersion } = await getJSON('/version');
  const expectsMarkers = Number(String(serverVersion).split('.')[1]) >= 32;
  // The 0.32 lane passes expect=032; a broken hand-off would otherwise run it
  // as 0.31 and skip every marker assertion while still reporting green.
  const expect032 = new URLSearchParams(location.search).get('expect') === '032';
  check('I0 the 0.32 info lane runs against a 0.32 server',
    !expect032 || expectsMarkers, `expect=${expect032} version=${serverVersion}`);
  const countSpans = [...document.querySelectorAll('[aria-label="Counts"] > *')];
  const oPill = countSpans.find(el => el.textContent.trim() === '4242 O');
  const markerPill = countSpans.find(el => el.textContent.trim() === '57 markers');
  check('I7 a studio offers five filterable counts; O and markers stay numbers',
    studioCountIds.length === 5
      && ['scenes', 'images', 'galleries', 'performers', 'groups']
        .every(t => studioCountIds.includes(`entity-count-${t}`))
      && !studioCountIds.includes('entity-count-o')
      && oPill?.tagName === 'SPAN'
      && (expectsMarkers ? markerPill?.tagName === 'SPAN' : markerPill === undefined),
    `ids=[${studioCountIds.join(',')}] version=${serverVersion} `
      + `oPill=${oPill?.tagName} markerPill=${markerPill?.tagName}`);

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

  // ── I9: a group's Info sheet ────────────────────────────
  await gotoTab('groups');
  await waitFor(() => live('group-1'));
  await clearLogs();
  const groupOpen = await chooseMenuRow('group-1', 'menu-entity-info');
  const groupSheet = await waitFor(() => !!sheetEl(), 4000);
  const groupFetched = await waitForAsync(async () => (await getJSON('/groupinfofetches'))
    .some(f => f.id === '1'), 4000);
  // The fetch log is written before the answer is, so the log alone can win
  // the race. Wait for the merged title, which only the detail can provide.
  const groupRendered = await waitFor(
    () => sheetTitle() === 'VERIFY group info 1', 4000);
  const groupText = sheetEl()?.textContent || '';
  check('I9 a group card\'s menu opens its Info sheet',
    groupOpen.opened && groupOpen.row && groupSheet && groupFetched && groupRendered,
    `menu=${groupOpen.opened} row=${groupOpen.row} sheet=${groupSheet} `
      + `fetch=${groupFetched} rendered=${groupRendered} errors: ${errorTail()}`);
  check('I9 the group answer is merged over the card',
    sheetTitle() === 'VERIFY group info 1'
      && groupText.includes('★ 8.0')
      && groupText.includes('31 scenes') && groupText.includes('32 performers')
      && groupText.includes('4242 O')
      && groupText.includes('2023-07-04') && groupText.includes('1:30:00')
      && groupText.includes('Dir. VERIFY group director'),
    `title="${sheetTitle()}" rating=${groupText.includes('★ 8.0')} `
    + `scenes=${groupText.includes('31 scenes')} performers=${groupText.includes('32 performers')} `
    + `o=${groupText.includes('4242 O')} date=${groupText.includes('2023-07-04')} `
    + `time=${groupText.includes('1:30:00')} director=${groupText.includes('Dir. VERIFY group director')}`);
  check('I9 synopsis, aliases, tags and both group directions are listed',
    groupText.includes('VERIFY group info synopsis.')
      && groupText.includes('VERIFY group alias one')
      && groupText.includes('Part of') && groupText.includes('VERIFY containing group')
      && groupText.includes('Includes') && groupText.includes('VERIFY subgroup one')
      && groupText.includes('Tags') && groupText.includes('VERIFY group info tag one'),
    `synopsis=${groupText.includes('VERIFY group info synopsis.')} `
    + `aliases=${groupText.includes('VERIFY group alias one')} `
    + `partOf=${groupText.includes('VERIFY containing group')} `
    + `includes=${groupText.includes('VERIFY subgroup one')}`);
  const groupQuery = (await getJSON('/groupinfofetches')).find(f => f.id === '1')?.query || '';
  check('I9 the group query reads the relation links as group { name }',
    ['containing_groups', 'sub_groups', 'group {', 'synopsis', 'duration', 'performer_count']
      .every(f => groupQuery.includes(f)),
    `missing=${['containing_groups', 'sub_groups', 'group {', 'synopsis', 'duration',
      'performer_count'].filter(f => !groupQuery.includes(f))}`);
  await waitFor(() => [...registry.keys()]
    .filter(id => id.startsWith('entity-count-')).length === 2, 2000);
  const groupCountIds = [...registry.keys()].filter(id => id.startsWith('entity-count-'));
  check('I9 a group\'s scene and performer counts are stops, O stays a number',
    groupCountIds.length === 2
      && groupCountIds.includes('entity-count-scenes')
      && groupCountIds.includes('entity-count-performers'),
    `ids=[${groupCountIds.join(',')}]`);
  await pressBack();
  const backToGroup = await waitFor(() => getCurrentFocusId() === 'group-1', 3000);
  check('I9 Back returns to the group card', backToGroup, `focus=${getCurrentFocusId()}`);

  // ── I10: a gallery's Info sheet ─────────────────────────
  await gotoTab('galleries');
  await waitFor(() => live('gallery-1'));
  await clearLogs();
  const galleryOpen = await chooseMenuRow('gallery-1', 'menu-gallery-info');
  const gallerySheet = await waitFor(() => !!sheetEl(), 4000);
  const galleryFetched = await waitForAsync(async () => (await getJSON('/galleryinfofetches'))
    .some(f => f.id === '1'), 4000);
  // Same race as I9: wait for the detail title before reading the sheet.
  const galleryRendered = await waitFor(
    () => sheetTitle() === 'VERIFY gallery info 1', 4000);
  const galleryText = sheetEl()?.textContent || '';
  const galleryStepper = () =>
    sheetEl()?.querySelector('[aria-label^="Rating, "]')?.getAttribute('aria-label');
  check('I10 a gallery card\'s menu offers Info and opens the sheet',
    galleryOpen.opened && galleryOpen.row && gallerySheet && galleryFetched
      && galleryRendered,
    `menu=${galleryOpen.opened} row=${galleryOpen.row} sheet=${gallerySheet} `
      + `fetch=${galleryFetched} rendered=${galleryRendered} errors: ${errorTail()}`);
  // The rating is a live stepper here, so the read-only pill must be gone; two
  // copies of the value could disagree after a write.
  check('I10 the gallery answer is merged, counts derived from its lists',
    sheetTitle() === 'VERIFY gallery info 1'
      && galleryStepper() === 'Rating, 7 of 10'
      && !galleryText.includes('★ 7.0')
      && galleryText.includes('33 images')
      && galleryText.includes('4 scenes')
      && galleryText.includes('3 performers')
      && galleryText.includes('VERIFY gallery photographer')
      && galleryText.includes('VERIFY gallery info studio')
      && galleryText.includes('VERIFY gallery folder'),
    `title="${sheetTitle()}" stepper=${galleryStepper()} `
    + `oldPill=${galleryText.includes('★ 7.0')} `
    + `images=${galleryText.includes('33 images')} scenes=${galleryText.includes('4 scenes')} `
    + `performers=${galleryText.includes('3 performers')} photo=${galleryText.includes('VERIFY gallery photographer')}`);
  check('I10 details, performers and tags are listed',
    galleryText.includes('VERIFY gallery info details.')
      && galleryText.includes('VERIFY gallery performer one')
      && galleryText.includes('VERIFY gallery info tag one'),
    `details=${galleryText.includes('VERIFY gallery info details.')} `
    + `performers=${galleryText.includes('VERIFY gallery performer one')} `
    + `tags=${galleryText.includes('VERIFY gallery info tag one')}`);
  const galleryQuery = (await getJSON('/galleryinfofetches')).find(f => f.id === '1')?.query || '';
  check('I10 the gallery query asks for the lists its counts are derived from',
    ['performers', 'scenes', 'image_count', 'tags', 'folder']
      .every(f => galleryQuery.includes(f)),
    `missing=${['performers', 'scenes', 'image_count', 'tags', 'folder']
      .filter(f => !galleryQuery.includes(f))}`);
  await waitFor(() => [...registry.keys()]
    .filter(id => id.startsWith('entity-count-')).length === 3, 2000);
  const galleryCountIds = [...registry.keys()].filter(id => id.startsWith('entity-count-'));
  check('I10 images, scenes and performers are all stops',
    galleryCountIds.length === 3
      && galleryCountIds.includes('entity-count-images')
      && galleryCountIds.includes('entity-count-scenes')
      && galleryCountIds.includes('entity-count-performers'),
    `ids=[${galleryCountIds.join(',')}]`);
  focus('entity-count-performers');
  await sleep(80);
  await tapEnter();
  const onGalleryPerformers = await waitFor(
    () => railActive().toLowerCase() === 'performers', 5000);
  // PerformerFilterType has no `galleries` criterion, so this must arrive as
  // the nested gallery filter with an Int id.
  const galleryPerformersFiltered = await waitForAsync(async () => (await getJSON('/requests'))
    .some(r => r.performer_filter?.galleries_filter?.id?.value === 1), 4000);
  check('I10 the performer count opens Performers through the nested gallery filter',
    onGalleryPerformers && galleryPerformersFiltered && !sheetEl(),
    `rail=${railActive()} filtered=${galleryPerformersFiltered} sheet=${!!sheetEl()}`);
  await pressBack();
  const backToGallery = await waitFor(() => getCurrentFocusId() === 'gallery-1', 3000);
  check('I10 Back returns to the gallery card', backToGallery, `focus=${getCurrentFocusId()}`);

  // ── I10b: a gallery's rating and organised flag are writes ──
  await clearLogs();
  await chooseMenuRow('gallery-1', 'menu-gallery-info');
  await waitFor(() => galleryStepper() === 'Rating, 7 of 10', 4000);
  focus('entity-rating-inc');
  await sleep(80);
  await tapEnter();
  const ratingPainted = await waitFor(() => galleryStepper() === 'Rating, 8 of 10', 3000);
  const ratingWritten = await waitForAsync(async () => {
    const rows = await getJSON('/galleryupdates');
    return rows.length === 1 && rows[0].id === '1' && rows[0].input.rating100 === 80;
  }, 3000);
  check('I10b the stepper sends a 0-100 value and paints the answer',
    ratingPainted && ratingWritten,
    `stepper=${galleryStepper()} writes=${JSON.stringify(await getJSON('/galleryupdates'))}`);

  const orgBtn = () => registry.get('entity-action-organized')?.el;
  focus('entity-action-organized');
  await sleep(80);
  await tapEnter();
  const orgWritten = await waitForAsync(async () => {
    const rows = await getJSON('/galleryupdates');
    return rows.length === 2 && rows[1].input.organized === false;
  }, 3000);
  check('I10b the organised toggle sends the flipped value',
    orgWritten && orgBtn()?.getAttribute('aria-pressed') === 'false',
    `pressed=${orgBtn()?.getAttribute('aria-pressed')} `
    + `writes=${JSON.stringify(await getJSON('/galleryupdates'))}`);

  // A refused write must put the control back and say so, not leave the lie up.
  await setMode('galleryUpdate', 'fail');
  await tapEnter();
  const orgRolledBack = await waitFor(
    () => orgBtn()?.getAttribute('aria-pressed') === 'false'
      && /Organised mark not saved/.test(sheetEl()?.textContent || ''),
    4000,
  );
  check('I10b a failed write rolls the toggle back and names the failure',
    orgRolledBack, (sheetEl()?.textContent || '').replace(/\s+/g, ' ').slice(0, 120));
  await setMode('galleryUpdate', 'ok');

  await pressBack();
  const galleryCardText = () => registry.get('gallery-1')?.el?.textContent || '';
  const cardPainted = await waitFor(() => /★ 8\.0/.test(galleryCardText()), 3000);
  check('I10b the card badge follows the write without a refetch',
    cardPainted, galleryCardText().replace(/\s+/g, ' ').slice(0, 80));

  // ── I11: a tag's and a studio's favourite are writes ────
  // Tags open as rows. The row has to carry the star too, or a favourite would
  // only show inside the sheet; the fixture marks every fourth tag, so tag 4
  // draws one and tag 2 does not. Then switch to Classic: the card's own star
  // is what proves the write patched the mounted row.
  await gotoTab('tags');
  await waitFor(() => live('tag-1'));
  const rowStar = (id) => registry.get(id)?.el?.querySelector('[aria-label="Favorite"]');
  const rowHasStar = (id) => !!rowStar(id);
  // Direct child of the row: at its end, not over the portrait art where a
  // studio logo hides it. The control is the star moving back into the thumb.
  const starAtEnd = (id) => rowStar(id)?.parentElement === registry.get(id)?.el;
  check('I11 the list row draws the favourite star, and only when set',
    !!document.querySelector('[data-list-mode]')
      && rowHasStar('tag-4') && !rowHasStar('tag-2'),
    `list=${!!document.querySelector('[data-list-mode]')} `
      + `tag-4=${rowHasStar('tag-4')} tag-2=${rowHasStar('tag-2')}`);
  check('I11b the row star sits at the row end, outside the art',
    starAtEnd('tag-4'), `atEnd=${starAtEnd('tag-4')}`);
  await driveMode('classic');
  await waitFor(() => !!registry.get('tag-1')?.el?.querySelector('[aria-label="Favorite"]'), 3000);
  await clearLogs();
  await chooseMenuRow('tag-1', 'menu-entity-info');
  await waitFor(() => !!favBtn(), 4000);
  const pressed = () => favBtn()?.getAttribute('aria-pressed');
  await waitFor(() => pressed() === 'true', 3000);
  // The mounted card, not just the sheet, has to follow. The listing fixture
  // says not-favourite while the detail says favourited, and neither listing
  // handler reads the write, so a star can only come from the row patch.
  const star = () => !!registry.get('tag-1')?.el?.querySelector('[aria-label="Favorite"]');
  const starBefore = star();
  focus('entity-action-favorite');
  await sleep(80);
  await tapEnter();
  await waitFor(() => pressed() === 'false', 2000);
  await sleep(250);
  await tapEnter();
  const tagTwoWrites = await waitForAsync(
    async () => (await getJSON('/tagupdates')).length === 2, 3000);
  const starBack = await waitFor(star, 3000);
  const tagRows = await getJSON('/tagupdates');
  check('I11 each press sends the id and the value it flipped to',
    tagTwoWrites && tagRows[0]?.id === '1' && tagRows[0]?.input.favorite === false
      && tagRows[1]?.id === '1' && tagRows[1]?.input.favorite === true,
    JSON.stringify(tagRows));

  await pressBack();
  await waitFor(() => getCurrentFocusId() === 'tag-1', 3000);
  check('I11 the card star follows the write without a refetch',
    !starBefore && starBack,
    `before=${starBefore} after=${starBack} `
    + (registry.get('tag-1')?.el?.textContent || '').replace(/\s+/g, ' ').slice(0, 40));

  // Reopening is a fresh read: the fixture's detail says favourited, so the
  // assertion is that the write changed the answer, not that a cache is warm.
  const tagFetchesBefore = (await getJSON('/taginfofetches')).length;
  await chooseMenuRow('tag-1', 'menu-entity-info');
  await waitFor(() => !!favBtn(), 4000);
  const tagRefetched = await waitForAsync(
    async () => (await getJSON('/taginfofetches')).length > tagFetchesBefore, 3000);
  await waitFor(() => pressed() === 'true', 3000);
  check('I11 reopening reads the stored favourite from the server',
    tagRefetched && pressed() === 'true', `refetch=${tagRefetched} pressed=${pressed()}`);

  await setMode('tagUpdate', 'fail');
  focus('entity-action-favorite');
  await sleep(80);
  await tapEnter();
  const favRolledBack = await waitFor(
    () => pressed() === 'true'
      && /Favourite not saved/.test(sheetEl()?.textContent || ''),
    4000,
  );
  check('I11 a refused favourite write rolls back and names the failure',
    favRolledBack, (sheetEl()?.textContent || '').replace(/\s+/g, ' ').slice(0, 120));
  await setMode('tagUpdate', 'ok');

  await tapEnter();
  await waitFor(() => pressed() === 'false', 2000);
  await sleep(250);
  await pressBack();
  await waitFor(() => getCurrentFocusId() === 'tag-1', 3000);
  const tagFetchesAgain = (await getJSON('/taginfofetches')).length;
  await chooseMenuRow('tag-1', 'menu-entity-info');
  await waitFor(() => !!favBtn(), 4000);
  const tagRefetchedAgain = await waitForAsync(
    async () => (await getJSON('/taginfofetches')).length > tagFetchesAgain, 3000);
  check('I11 the reopened sheet shows the value the server now holds',
    tagRefetchedAgain && pressed() === 'false',
    `refetch=${tagRefetchedAgain} pressed=${pressed()} `
    + `writes=${(await getJSON('/tagupdates')).length}`);
  await pressBack();
  await waitFor(() => getCurrentFocusId() === 'tag-1', 3000);

  await gotoTab('studios');
  await waitFor(() => live('studio-4'));
  await clearLogs();
  await chooseMenuRow('studio-4', 'menu-entity-info');
  await waitFor(() => !!favBtn(), 4000);
  await waitFor(() => pressed() === 'true', 3000);
  focus('entity-action-favorite');
  await sleep(80);
  await tapEnter();
  const studioWritten = await waitForAsync(
    async () => (await getJSON('/studioupdates')).length === 1, 3000);
  const studioRows = await getJSON('/studioupdates');
  check('I11 the studio sheet writes its favourite through studioUpdate',
    studioWritten && studioRows[0]?.id === '4'
      && studioRows[0]?.input.favorite === false && pressed() === 'false',
    JSON.stringify(studioRows));
  await pressBack();
  await waitFor(() => getCurrentFocusId() === 'studio-4', 3000);

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
