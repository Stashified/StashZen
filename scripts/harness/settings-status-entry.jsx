/**
 * Headless driver for the Settings panels added in 0.20.0/0.21.0: Library
 * stats (#87), Server status (#88) and the Scan library action on it.
 *
 * Mounts the real SettingsPanel against the fake GraphQL endpoint, the way
 * actions-entry.jsx does. Each phase remounts with a fresh key so the
 * section's local state (closed / loading / ready / error) starts where the
 * phase needs it, and the fake's `/clear` resets the per-feature fetch log so
 * "exactly one fetch" is a count a check can make.
 *
 * What this does not cover: whether a real Stash server answers these fields
 * (the fake can only prove the client asks and renders), and anything about
 * how the sections look on a TV panel. Those are the TV pass's job.
 */

import { createRoot } from 'react-dom/client';
// The real theme: the layout checks below read computed geometry, and without
// the variables the tiles would collapse to unstyled boxes.
import '../../src/index.css';
import SettingsPanel from '../../src/components/SettingsPanel.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeout = 4000, step = 50) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await sleep(step);
  }
  return null;
}

// ── Input ───────────────────────────────────────────────────
const active = () => document.activeElement || document.body;
function press(key, keyCode) {
  active().dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}
const buttons = () => [...document.querySelectorAll('[role="dialog"] button')];
const byLabel = (label) => buttons().find(b => b.textContent.trim() === label);
const labels = () => buttons().map(b => b.textContent.trim());
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent || '';
const group = (label) => document.querySelector(`[role="group"][aria-label="${label}"]`);

async function enterLabel(label) {
  const button = byLabel(label);
  if (!button) throw new Error(`no button labelled "${label}" (have: ${labels().join(' | ')})`);
  button.focus();
  await sleep(50);
  press('Enter', 13);
  await sleep(180);
}

// Enter on a button by its focus-registry id. The job rows have no DOM id and
// their labels change between presses, so the registry is the stable handle —
// and going through it also proves the row really registered the button.
async function enterFocusId(id) {
  const entry = registry.get(id);
  if (!entry) throw new Error(`no focusable "${id}" (have: ${[...registry.keys()].join(' | ')})`);
  entry.el.focus();
  await sleep(50);
  press('Enter', 13);
  await sleep(180);
}

// ── Fake-server controls ────────────────────────────────────
const getJSON = async (path) => (await fetch(path)).json();
const postMode = (patch) => fetch('/mode', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
});
const clearLogs = async () => {
  await fetch('/clear', { method: 'POST' });
  uncaught.length = 0;
};

// Anything the panels failed to catch. The error checks assert this is empty,
// because a caught error and an unhandled rejection can both leave the same
// warning on screen while the latter also breaks the session.
const uncaught = [];
window.addEventListener('unhandledrejection', e => uncaught.push(String(e.reason)));
window.addEventListener('error', e => uncaught.push(String(e.message)));

// ── Mounting ────────────────────────────────────────────────
const root = createRoot(document.getElementById('root'));
let mountKey = 0;

async function mount({ mock }) {
  setSettings(mock
    ? { useMock: true, onboarded: 'test' }
    : { useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness', onboarded: 'live' });
  mountKey += 1;
  root.render(<SettingsPanel key={mountKey} onClose={() => {}} />);
  // Long enough for useFocusable to register the section's button and for the
  // panel's own effects (which focus the URL field in Live mode) to settle.
  await sleep(500);
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

// ═══════════════════════════════════════════════════════════
// #87 — Library stats
// ═══════════════════════════════════════════════════════════
async function runStats() {
  await mount({ mock: false });
  await clearLogs();
  await postMode({ stats: 'ok' });

  // ── S1  Closed by default ───────────────────────────────
  check('S1 stats start closed and unfetched',
    !!byLabel('Show library stats') && !group('Library stats')
      && (await getJSON('/statsfetches')).length === 0,
    `labels: ${labels().join(' | ')}`);

  // ── S2  Loading, then the grid ──────────────────────────
  // The slow arm holds the response for 1.2 s, long enough to observe the
  // button label and the absence of the grid without a race.
  await postMode({ stats: 'slow' });
  await enterLabel('Show library stats');
  check('S2a a slow fetch shows Loading… and no grid',
    !!byLabel('Loading…') && !group('Library stats'),
    `labels: ${labels().join(' | ')}`);
  const grid = await waitFor(() => group('Library stats'), 4000);
  check('S2b the grid lands when the fetch answers', !!grid,
    `grid: ${grid ? 'present' : 'missing'}`);

  const text = grid?.textContent || '';

  // ── S3  Counts are grouped ──────────────────────────────
  check('S3 counts are comma-grouped',
    text.includes('1,234') && text.includes('98,765') && text.includes('4,321'),
    `1,234=${text.includes('1,234')} 98,765=${text.includes('98,765')} 4,321=${text.includes('4,321')}`);

  // ── S4  Storage is both byte sums ───────────────────────
  // 1.5 GiB + 1 GiB. Showing either field alone ("1.5 GiB") or the raw sum
  // is a different string, so this cannot pass by accident.
  check('S4 storage is the sum of scene and image sizes',
    text.includes('2.5 GiB') && !text.includes('1.5 GiB'),
    `2.5 GiB=${text.includes('2.5 GiB')} 1.5 GiB=${text.includes('1.5 GiB')}`);

  // ── S5  Durations round, not floor ──────────────────────
  check('S5 video and watch time round to whole hours',
    text.includes('1,251 h') && text.includes('2,501 h')
      && !text.includes('1,250 h') && !text.includes('2,500 h'),
    `1,251=${text.includes('1,251 h')} 2,501=${text.includes('2,501 h')}`);

  // ── S6  Engagement counts ───────────────────────────────
  check('S6 plays, played scenes and the o-count render',
    text.includes('54,321') && text.includes('3,456') && text.includes('777')
      && text.includes('O-count') && !text.includes('Likes'),
    `54,321=${text.includes('54,321')} 3,456=${text.includes('3,456')} 777=${text.includes('777')}`
      + ` O-count=${text.includes('O-count')} Likes=${text.includes('Likes')}`);

  // ── S7  One narrow query ────────────────────────────────
  const fetches = await getJSON('/statsfetches');
  const ops = (await getJSON('/graphqlcalls')).filter(n => n === 'LibraryStats');
  const queryText = fetches[0] || '';
  check('S7 one narrow LibraryStats call',
    fetches.length === 1 && ops.length === 1
      && queryText.includes('scene_count')
      && queryText.includes('total_play_duration')
      && queryText.includes('scenes_played')
      && !queryText.includes('group_count')
      && !queryText.includes('movie_count'),
    `fetches=${fetches.length} ops=${ops.length} narrow=${queryText.includes('scenes_played')}`);

  // ── S8  Hide/show is free ───────────────────────────────
  const beforeHide = fetches.length;
  await enterLabel('Hide library stats');
  await sleep(350);
  const hidden = !group('Library stats') && !!byLabel('Show library stats');
  await enterLabel('Show library stats');
  const shown = await waitFor(() => group('Library stats'), 1000);
  const afterShow = (await getJSON('/statsfetches')).length;
  check('S8 hide/show reuses the answer without refetching',
    hidden && !!shown && afterShow === beforeHide,
    `hidden=${hidden} shown=${!!shown} fetches ${beforeHide} → ${afterShow}`);

  // ── S9  Failure ─────────────────────────────────────────
  await mount({ mock: false });
  await clearLogs();
  await postMode({ stats: 'fail' });
  await enterLabel('Show library stats');
  const failed = await waitFor(
    () => dialogText().includes("Couldn't load library stats"), 5000);
  check('S9 a failed fetch shows its message and offers Try again',
    !!failed && !!byLabel('Try again') && !group('Library stats') && uncaught.length === 0,
    `warning=${!!failed} retry=${!!byLabel('Try again')} uncaught=${uncaught.length}`);

  // ── S10 Retry ───────────────────────────────────────────
  await postMode({ stats: 'ok' });
  await enterLabel('Try again');
  const retried = await waitFor(() => group('Library stats'), 4000);
  const retryFetches = (await getJSON('/statsfetches')).length;
  check('S10 Try again fetches once more and recovers',
    !!retried && retryFetches === 2,
    `grid=${!!retried} fetches=${retryFetches}`);

  // ── S11 Test mode ───────────────────────────────────────
  await mount({ mock: true });
  await clearLogs();
  await enterLabel('Show library stats');
  const mockGrid = await waitFor(() => group('Library stats'), 2000);
  const mockText = mockGrid?.textContent || '';
  const mockFetches = (await getJSON('/statsfetches')).length;
  check('S11 Test mode uses fixed mock stats and makes no request',
    !!mockGrid && mockText.includes('1,245') && mockText.includes('5 GiB')
      && mockText.includes('4 h') && mockFetches === 0,
    `values=${mockText.includes('1,245')}/${mockText.includes('5 GiB')} fetches=${mockFetches}`);

  // ── S12 Inert tiles ─────────────────────────────────────
  // Twelve tiles must add zero D-pad stops. Checked against both the DOM
  // (nothing focusable) and the real focus registry (nothing registered).
  const focusableInGrid = mockGrid
    ? mockGrid.querySelectorAll('button, a, [tabindex], [role="button"], [role="link"]').length
    : -1;
  const registeredInGrid = mockGrid
    ? [...registry.values()].filter(entry => entry.el && mockGrid.contains(entry.el)).length
    : -1;
  const focusOnButton = document.activeElement?.tagName === 'BUTTON'
    && /library stats/i.test(document.activeElement.textContent);
  check('S12 stat tiles are inert and focus stays on the button',
    focusableInGrid === 0 && registeredInGrid === 0 && focusOnButton,
    `focusable=${focusableInGrid} registered=${registeredInGrid} focusOnButton=${focusOnButton}`);

  // ── S13 Layout ──────────────────────────────────────────
  check('S13 the stats grid fits its column',
    !!mockGrid && mockGrid.scrollWidth <= mockGrid.clientWidth + 1,
    mockGrid ? `${mockGrid.scrollWidth} <= ${mockGrid.clientWidth} + 1` : 'no grid');
}

// ═══════════════════════════════════════════════════════════
// #88 — Server status
// ═══════════════════════════════════════════════════════════
async function runServer() {
  await mount({ mock: false });
  await clearLogs();
  await postMode({ serverStatus: 'ok' });

  // ── V1  Closed by default ───────────────────────────────
  check('V1 server status starts closed and unfetched',
    !!byLabel('Check server status') && !group('Server status')
      && (await getJSON('/statusfetches')).length === 0,
    `labels: ${labels().join(' | ')}`);

  // ── V2  Loading, then the snapshot ──────────────────────
  await postMode({ serverStatus: 'slow' });
  await enterLabel('Check server status');
  check('V2a a slow check shows Checking… and no snapshot',
    !!byLabel('Checking…') && !group('Server status'),
    `labels: ${labels().join(' | ')}`);
  const snapshot = await waitFor(() => group('Server status'), 4000);
  const snapText = snapshot?.textContent || '';
  check('V2b the snapshot shows version, health and schema gap',
    !!snapshot
      && snapText.includes('Stash 0.31.1-harness')
      && snapText.includes('Needs migration')
      && snapText.includes('schema 30 → 31'),
    snapText.slice(0, 120));

  // ── V3  Only active jobs ────────────────────────────────
  // The fixture's second job is FINISHED. Showing it is the mistake this
  // checks for, and the description is deliberately unique.
  check('V3 finished jobs are filtered out of the run list',
    snapText.includes('VERIFY scan running')
      && snapText.includes('42%')
      && !snapText.includes('VERIFY finished job'),
    `running=${snapText.includes('VERIFY scan running')} finished=${snapText.includes('VERIFY finished job')}`);

  // ── V3b Subtasks, start time and the failure reason ─────
  // The fixture's running job has four subtasks; the row shows three. The
  // fourth's absence is the cap, not a coincidence of the fixture.
  check('V3b a job row lists at most three subtasks',
    snapText.includes('VERIFY subtask one · VERIFY subtask two · VERIFY subtask three')
      && !snapText.includes('VERIFY subtask four'),
    `joined=${snapText.includes('VERIFY subtask one · VERIFY subtask two · VERIFY subtask three')} `
    + `fourth=${snapText.includes('VERIFY subtask four')}`);
  const startDate = new Date('2024-05-01T09:30:00Z');
  const startClock = `${String(startDate.getHours()).padStart(2, '0')}:`
    + `${String(startDate.getMinutes()).padStart(2, '0')}`;
  check('V3c the start time is a local wall clock, not the raw ISO string',
    snapText.includes(`Started ${startClock}`)
      && !snapText.includes('2024-05-01T09:30:00Z'),
    `wanted "Started ${startClock}", has ISO=${snapText.includes('2024-05-01T09:30:00Z')}`);
  check('V3d a failed job is shown with its reason',
    snapText.includes('VERIFY failed job') && snapText.includes('Failed')
      && snapText.includes('VERIFY failure reason: the media folder is not mounted'),
    `failedRow=${snapText.includes('VERIFY failed job')} error=${snapText.includes('the media folder is not mounted')}`);
  check('V3e only RUNNING and READY jobs carry a Stop button',
    !!registry.get('settings-job-stop-job-1')
      && !registry.get('settings-job-stop-job-3')
      && snapshot.querySelectorAll('button').length === 1,
    `stop1=${!!registry.get('settings-job-stop-job-1')} `
    + `stop3=${!!registry.get('settings-job-stop-job-3')} `
    + `buttons=${snapshot.querySelectorAll('button').length}`);

  // ── V4  One query, all three roots ──────────────────────
  // The shadowing trap lives here: the fake's anonymous connection-test arm
  // matches `version {`, so a status handler placed below it would answer
  // this query with version alone. V2 is what goes red in that case.
  const statusFetches = await getJSON('/statusfetches');
  const statusOps = (await getJSON('/graphqlcalls')).filter(n => n === 'ServerStatus');
  const statusQuery = statusFetches[0] || '';
  check('V4 one ServerStatus call carrying version, health and the full job rows',
    statusFetches.length === 1 && statusOps.length === 1
      && statusQuery.includes('version')
      && statusQuery.includes('systemStatus')
      && statusQuery.includes('jobQueue')
      && ['subTasks', 'error', 'startTime'].every(f => statusQuery.includes(f)),
    `fetches=${statusFetches.length} ops=${statusOps.length} `
    + `missing=${['subTasks', 'error', 'startTime'].filter(f => !statusQuery.includes(f))}`);

  // ── V5  Failure, then recovery ──────────────────────────
  await mount({ mock: false });
  await clearLogs();
  await postMode({ serverStatus: 'fail' });
  await enterLabel('Check server status');
  const failed = await waitFor(
    () => dialogText().includes("Couldn't load server status"), 5000);
  check('V5a a failed check shows its message and offers Try again',
    !!failed && !!byLabel('Try again') && uncaught.length === 0,
    `warning=${!!failed} retry=${!!byLabel('Try again')} uncaught=${uncaught.length}`);

  await postMode({ serverStatus: 'migrated' });
  await enterLabel('Try again');
  const healthy = await waitFor(() => {
    const g = group('Server status');
    return g && g.textContent.includes('· OK') ? g : null;
  }, 4000);
  const healthyText = healthy?.textContent || '';
  const retryCalls = (await getJSON('/statusfetches')).length;
  check('V5b Try again recovers and reports the healthy snapshot',
    !!healthy && healthyText.includes('No jobs running.') && retryCalls === 2,
    `healthy=${!!healthy} fetches=${retryCalls}`);

  // ── V8  Refresh ─────────────────────────────────────────
  // Run here, while a snapshot is already on screen: the fetch count is a
  // delta, so an extra mount-time call could not make this pass.
  const beforeRefresh = (await getJSON('/statusfetches')).length;
  await postMode({ serverStatus: 'ok' });
  await enterLabel('Refresh');
  const refreshed = await waitFor(() => {
    const g = group('Server status');
    return g && g.textContent.includes('Needs migration') ? g : null;
  }, 4000);
  const afterRefresh = (await getJSON('/statusfetches')).length;
  check('V8 Refresh takes exactly one new snapshot',
    !!refreshed && afterRefresh === beforeRefresh + 1,
    `fetches ${beforeRefresh} → ${afterRefresh}`);

  // ── V7  The rows' only D-pad stop is Stop ───────────────
  // The old version of this check asserted the rows were inert. They are not
  // any more: a stoppable job carries exactly one focusable button, the
  // FAILED job none. Anything else (a focusable status line, a second stop
  // per row) would change what the D-pad walks through.
  const refreshedButtons = refreshed
    ? refreshed.querySelectorAll('button, a, [tabindex], [role="button"], [role="link"]').length
    : -1;
  const refreshedIds = refreshed
    ? [...registry.entries()].filter(([, e]) => e.el && refreshed.contains(e.el)).map(([id]) => id)
    : [];
  const focusOnServerButton = document.activeElement?.tagName === 'BUTTON'
    && document.activeElement.textContent.trim() === 'Refresh';
  check('V7 each stoppable job adds one Stop stop; the failed row adds none',
    refreshedButtons === 1 && refreshedIds.length === 1
      && refreshedIds[0] === 'settings-job-stop-job-1' && focusOnServerButton,
    `focusable=${refreshedButtons} registered=[${refreshedIds.join(',')}] `
    + `focus=${document.activeElement?.textContent?.trim()}`);

  // ── V6  Test mode ───────────────────────────────────────
  await mount({ mock: true });
  await clearLogs();
  await enterLabel('Check server status');
  const mockSnapshot = await waitFor(() => group('Server status'), 2000);
  const mockText = mockSnapshot?.textContent || '';
  const mockCalls = (await getJSON('/statusfetches')).length;
  check('V6 Test mode shows a mock snapshot and makes no request',
    !!mockSnapshot
      && mockText.includes('Stash 0.31.1')
      && mockText.includes('Scanning metadata')
      && mockText.includes('42%')
      && mockCalls === 0,
    `version=${mockText.includes('Stash 0.31.1')} job=${mockText.includes('Scanning metadata')} fetches=${mockCalls}`);
}

// ═══════════════════════════════════════════════════════════
// #90 — Scan library
// ═══════════════════════════════════════════════════════════
const scanNote = () => dialogText().match(/Scan started[^.]*\.|Test mode[^.]*\.|Couldn't start a scan[^\n]*/)?.[0] || '';

async function runScan() {
  await mount({ mock: false });
  await clearLogs();
  await postMode({ scan: 'ok', scanDefaults: 'ok', serverStatus: 'ok' });

  // ── W1  Present and does nothing until pressed ──────────
  check('W1 the scan button exists and starts nothing on its own',
    !!byLabel('Scan library') && !group('Server status')
      && (await getJSON('/scanfetches')).length === 0,
    `labels: ${labels().join(' | ')}`);

  // ── W2  Slow mutation, then note + snapshot ─────────────
  // The slow arm holds the mutation for 1.2 s, so "Starting…" and the absence
  // of any status fetch before the server confirms are both observable.
  await postMode({ scan: 'slow', scanDefaults: 'ok' });
  await enterLabel('Scan library');
  check('W2a a pending scan shows Starting… and neither a note nor a snapshot fetch',
    !!byLabel('Starting…') && scanNote() === ''
      && (await getJSON('/statusfetches')).length === 0,
    `labels: ${labels().join(' | ')} note="${scanNote()}" statusFetches=${(await getJSON('/statusfetches')).length}`);

  const scanSnapshot = await waitFor(() => group('Server status'), 5000);
  const scanSnapshotText = scanSnapshot?.textContent || '';
  const scanFetches = await getJSON('/scanfetches');
  const scanOps = (await getJSON('/graphqlcalls')).filter(n => n === 'LibraryScan');
  const variables = scanFetches[0]?.variables || {};
  const scanQuery = scanFetches[0]?.query || '';
  check('W2b success notes the scan, then takes one snapshot showing the job',
    !!scanSnapshot
      && scanNote().includes('Scan started')
      && scanSnapshotText.includes('VERIFY scan running')
      && (await getJSON('/statusfetches')).length === 1,
    `note="${scanNote()}" snapshot=${!!scanSnapshot} fetches=${(await getJSON('/statusfetches')).length}`);

  // The saved options, written out here rather than imported from the fake
  // server. If the mutation's input and the server's answer were the same
  // constant, "the client copies the options" would be true by construction.
  // Key order is not part of the contract, so compare sorted keys.
  const sorted = o => JSON.stringify(Object.fromEntries(
    Object.entries(o || {}).sort(([a], [b]) => a.localeCompare(b))));
  // `ui.taskDefaults.scan` — the block Stash's own scan page writes when the
  // user changes a checkbox. This is the answer the scan must use.
  const UI_DEFAULTS = {
    rescan: true,
    scanGenerateCovers: false,
    scanGeneratePreviews: false,
    scanGenerateImagePreviews: true,
    scanGenerateSprites: false,
    scanGeneratePhashes: false,
    scanGenerateImagePhashes: true,
    scanGenerateThumbnails: true,
    scanGenerateClipPreviews: false,
  };
  // `configuration.defaults.scan` — the legacy system block, deliberately
  // different in every field. 0.22.0 sent *this* while the UI showed
  // UI_DEFAULTS; landing on these values is the reported bug.
  const SYSTEM_DEFAULTS = {
    rescan: false,
    scanGenerateCovers: true,
    scanGeneratePreviews: true,
    scanGenerateImagePreviews: false,
    scanGenerateSprites: true,
    scanGeneratePhashes: true,
    scanGenerateImagePhashes: false,
    scanGenerateThumbnails: false,
    scanGenerateClipPreviews: false,
  };
  const defaultsFetches = await getJSON('/scandefaultsfetches');
  const defaultsQuery = defaultsFetches[0] || '';
  const showsEveryOption = Object.keys(UI_DEFAULTS)
    .every(f => defaultsQuery.includes(f));
  check('W2c the scan copies the UI-saved options, not the system block',
    scanFetches.length === 1 && scanOps.length === 1
      && scanQuery.includes('metadataScan(input: $input)')
      && scanQuery.includes('$input: ScanMetadataInput!')
      && sorted(variables.input) === sorted(UI_DEFAULTS)
      && sorted(variables.input) !== sorted(SYSTEM_DEFAULTS)
      && defaultsFetches.length === 1 && showsEveryOption
      && defaultsQuery.includes('ui')
      && !defaultsQuery.includes('paths') && !defaultsQuery.includes('filter'),
    `fetches=${scanFetches.length} ops=${scanOps.length} input=${JSON.stringify(variables.input)} `
      + `defaultsFetches=${defaultsFetches.length} showsEveryOption=${showsEveryOption} `
      + `readsUi=${defaultsQuery.includes('ui')}`);

  // ── W2d  Read at press time, not memorised ──────────────
  // A client that hardcoded the set above would still pass W2c. Changing the
  // server's saved options between two presses is what tells the two apart.
  const ALT_DEFAULTS = {
    rescan: false,
    scanGenerateCovers: true,
    scanGeneratePreviews: false,
    scanGenerateImagePreviews: false,
    scanGenerateSprites: true,
    scanGeneratePhashes: false,
    scanGenerateImagePhashes: false,
    scanGenerateThumbnails: false,
    scanGenerateClipPreviews: true,
  };
  await postMode({ scan: 'ok', scanDefaults: 'alt' });
  await enterLabel('Scan library');
  await waitFor(() => !!byLabel('Scan library') && scanNote().includes('Scan started'), 5000);
  const altScanFetches = await getJSON('/scanfetches');
  const altDefaultsFetches = await getJSON('/scandefaultsfetches');
  check('W2d a second scan reads the options again and sends the new set',
    altScanFetches.length === 2 && altDefaultsFetches.length === 2
      && sorted(altScanFetches[1]?.variables?.input) === sorted(ALT_DEFAULTS),
    `scans=${altScanFetches.length} defaultsReads=${altDefaultsFetches.length} `
      + `input=${JSON.stringify(altScanFetches[1]?.variables?.input)}`);

  // ── W2e  No UI-saved options → the system block is the fallback ─
  // A UI store that has never saved scan options must not mean "generate
  // nothing", and must not mean "ignore defaults.scan". Stash's own UI falls
  // back to the system defaults in exactly this case.
  await postMode({ scan: 'ok', scanDefaults: 'system' });
  await enterLabel('Scan library');
  await waitFor(() => !!byLabel('Scan library') && scanNote().includes('Scan started'), 5000);
  const sysScanFetches = await getJSON('/scanfetches');
  check('W2e with no saved UI options the system defaults are the fallback',
    sysScanFetches.length === 3
      && sorted(sysScanFetches[2]?.variables?.input) === sorted(SYSTEM_DEFAULTS),
    `scans=${sysScanFetches.length} `
      + `input=${JSON.stringify(sysScanFetches[2]?.variables?.input)}`);

  // ── W3  Failure, then a successful retry ────────────────
  await mount({ mock: false });
  await clearLogs();
  await postMode({ scan: 'fail', scanDefaults: 'ok' });
  await enterLabel('Scan library');
  const scanFailed = await waitFor(
    () => dialogText().includes("Couldn't start a scan"), 5000);
  check('W3a a failed scan shows its message, restarts the button and does not fetch status',
    !!scanFailed && !!byLabel('Scan library') && !group('Server status')
      && (await getJSON('/statusfetches')).length === 0
      && uncaught.length === 0,
    `note="${scanNote()}" labels: ${labels().join(' | ')} statusFetches=${(await getJSON('/statusfetches')).length} uncaught=${uncaught.length}`);

  await postMode({ scan: 'ok' });
  await enterLabel('Scan library');
  const scanRetried = await waitFor(() => group('Server status'), 5000);
  check('W3b pressing again after the failure recovers',
    !!scanRetried && scanNote().includes('Scan started')
      && (await getJSON('/scanfetches')).length === 2,
    `snapshot=${!!scanRetried} note="${scanNote()}" fetches=${(await getJSON('/scanfetches')).length}`);

  // ── W3c  A failed defaults read is not "scan anyway" ────
  // Falling back to an empty input here would reproduce the original bug in
  // the one situation where it is easiest to miss: Stash answers the mutation,
  // the panel says the scan started, and no artwork is generated.
  await mount({ mock: false });
  await clearLogs();
  await postMode({ scan: 'ok', scanDefaults: 'fail' });
  await enterLabel('Scan library');
  const defaultsFailed = await waitFor(
    () => dialogText().includes('simulated defaults failure'), 5000);
  check('W3c an unreadable defaults read stops before the mutation and says so',
    !!defaultsFailed && !!byLabel('Scan library')
      && (await getJSON('/scanfetches')).length === 0
      && (await getJSON('/statusfetches')).length === 0
      && uncaught.length === 0,
    `note="${scanNote()}" scanFetches=${(await getJSON('/scanfetches')).length} `
      + `statusFetches=${(await getJSON('/statusfetches')).length} uncaught=${uncaught.length}`);

  // ── W4  Scan with a snapshot already open ───────────────
  // The delta matters: the section must not refetch on mount, so the only
  // status fetch after /clear is the one the scan itself asks for.
  await mount({ mock: false });
  await clearLogs();
  await postMode({ scan: 'ok', scanDefaults: 'ok', serverStatus: 'ok' });
  await enterLabel('Check server status');
  await waitFor(() => group('Server status'), 4000);
  await clearLogs();
  await enterLabel('Scan library');
  const scanWhileOpen = await waitFor(
    () => scanNote().includes('Scan started'), 5000);
  await waitFor(() => !byLabel('Checking…'), 4000);
  check('W4 scanning with the snapshot open refreshes it exactly once',
    !!scanWhileOpen && !!group('Server status') && !!byLabel('Refresh')
      && (await getJSON('/statusfetches')).length === 1
      && (await getJSON('/scanfetches')).length === 1,
    `note="${scanNote()}" statusFetches=${(await getJSON('/statusfetches')).length} scanFetches=${(await getJSON('/scanfetches')).length}`);

  // ── W5  Test mode ───────────────────────────────────────
  await mount({ mock: true });
  await clearLogs();
  await enterLabel('Scan library');
  const mockScan = await waitFor(() => group('Server status'), 2000);
  const mockScanText = mockScan?.textContent || '';
  check('W5 Test mode says no server was contacted and makes no request',
    !!mockScan && scanNote().includes('Test mode')
      && mockScanText.includes('Scanning metadata')
      && (await getJSON('/scanfetches')).length === 0
      && (await getJSON('/scandefaultsfetches')).length === 0,
    `note="${scanNote()}" snapshot=${!!mockScan} fetches=${(await getJSON('/scanfetches')).length} `
      + `defaultsFetches=${(await getJSON('/scandefaultsfetches')).length}`);
}

// ═══════════════════════════════════════════════════════════
// #88b — Stopping a job (item 10)
// ═══════════════════════════════════════════════════════════
const stopFetches = async () => getJSON('/stopfetches');
const focusIdOf = (el) => [...registry.entries()]
  .find(([, entry]) => entry.el === el)?.[0] || null;

async function openStatus() {
  await mount({ mock: false });
  await clearLogs();
  await postMode({ serverStatus: 'ok', stopJob: 'ok' });
  await enterLabel('Check server status');
  return waitFor(() => group('Server status'), 4000);
}

async function runStop() {
  // ── R1  First press arms, sends nothing ─────────────────
  await openStatus();
  await enterFocusId('settings-job-stop-job-1');
  const stopBtn = () => registry.get('settings-job-stop-job-1')?.el;
  check('R1 the first press only arms the button',
    stopBtn()?.textContent.trim() === 'Press again to stop'
      && (await stopFetches()).length === 0
      && !!group('Server status'),
    `label="${stopBtn()?.textContent.trim()}" fetches=${(await stopFetches()).length}`);

  // ── R2  Second press commits once; the row goes; focus moves ─
  await enterFocusId('settings-job-stop-job-1');
  const removed = await waitFor(() => {
    const g = group('Server status');
    return g && !g.textContent.includes('VERIFY scan running') ? g : null;
  }, 6000);
  const afterStop = await stopFetches();
  check('R2 the second press sends exactly one StopJob for the armed job',
    afterStop.length === 1 && afterStop[0].job_id === 'job-1'
      && /stopJob\(job_id: \$jobId\)/.test(afterStop[0].query)
      && afterStop[0].query.includes('mutation StopJob'),
    `fetches=${afterStop.length} id=${afterStop[0]?.job_id}`);
  check('R3 the stopped row disappears and the note says what happened',
    !!removed && !removed.textContent.includes('VERIFY scan running')
      && dialogText().includes('Stopping "VERIFY scan running"'),
    `removed=${!!removed} note=${dialogText().includes('Stopping "VERIFY scan running"')}`);
  // The refresh unmounts the job body, so the focused Stop element is gone.
  // Focus must already be somewhere the D-pad can move from.
  check('R4 focus lands on the status button before the row unmounts',
    focusIdOf(document.activeElement) === 'settings-server',
    `focus=<${document.activeElement?.tagName?.toLowerCase()}> `
    + `"${(document.activeElement?.textContent || '').trim()}" id=${focusIdOf(document.activeElement)}`);

  // ── R5  The server refuses with `false` ─────────────────
  // `stopJob` is Boolean!: a false answer means the job is still running. The
  // client must treat it as a failure rather than as "stopped".
  await openStatus();
  await postMode({ stopJob: 'false' });
  await enterFocusId('settings-job-stop-job-1');
  await enterFocusId('settings-job-stop-job-1');
  const refused = await waitFor(
    () => dialogText().includes("Couldn't stop the job"), 4000);
  check('R5 a false answer is reported as a failure and the row stays',
    !!refused && dialogText().includes('the server did not stop the job')
      && !!registry.get('settings-job-stop-job-1')
      && group('Server status')?.textContent.includes('VERIFY scan running')
      && (await stopFetches()).length === 1
      && uncaught.length === 0,
    `notice=${dialogText().includes('the server did not stop the job')} `
    + `row=${!!registry.get('settings-job-stop-job-1')} fetches=${(await stopFetches()).length}`);
  check('R5b ...and focus stays on Stop, one press from trying again',
    focusIdOf(document.activeElement) === 'settings-job-stop-job-1'
      && stopBtn()?.textContent.trim() === 'Stop',
    `id=${focusIdOf(document.activeElement)} label="${stopBtn()?.textContent.trim()}"`);

  // ── R6  In flight: Stopping…, and a third press is ignored ──
  await openStatus();
  await postMode({ stopJob: 'slow' });
  await enterFocusId('settings-job-stop-job-1');       // arm
  const slowEntry = registry.get('settings-job-stop-job-1');
  slowEntry.el.focus();
  press('Enter', 13);
  await sleep(200);
  check('R6a a stop in flight says Stopping…',
    slowEntry.el.textContent.trim() === 'Stopping…',
    `label="${slowEntry.el.textContent.trim()}"`);
  // Press again while the mutation is held. The row is still on screen; this
  // must neither re-arm nor send a second request.
  slowEntry.el.focus();
  press('Enter', 13);
  await sleep(200);
  check('R6b a press while stopping is ignored — still one request',
    slowEntry.el.textContent.trim() === 'Stopping…'
      && (await stopFetches()).length === 1,
    `label="${slowEntry.el.textContent.trim()}" fetches=${(await stopFetches()).length}`);
  const slowRemoved = await waitFor(() => {
    const g = group('Server status');
    return g && !g.textContent.includes('VERIFY scan running') ? g : null;
  }, 6000);
  check('R6c the slow stop still completes and removes the row', !!slowRemoved);

  // ── R7  Transport failure ───────────────────────────────
  await openStatus();
  await postMode({ stopJob: 'fail' });
  await enterFocusId('settings-job-stop-job-1');
  await enterFocusId('settings-job-stop-job-1');
  const failedStop = await waitFor(
    () => dialogText().includes('simulated stop failure'), 5000);
  check('R7 a failed stop keeps the row and reports the server\'s message',
    !!failedStop && !!registry.get('settings-job-stop-job-1')
      && focusIdOf(document.activeElement) === 'settings-job-stop-job-1'
      && (await stopFetches()).length === 1
      && uncaught.length === 0,
    `notice=${!!failedStop} row=${!!registry.get('settings-job-stop-job-1')} `
    + `uncaught=${uncaught.length}`);

  // ── R8  Test mode ───────────────────────────────────────
  await mount({ mock: true });
  await clearLogs();
  await enterLabel('Check server status');
  const mockSnap = await waitFor(() => group('Server status'), 3000);
  check('R8a Test mode offers Stop for the two active sample jobs only',
    !!mockSnap && !!registry.get('settings-job-stop-mock-scan')
      && !!registry.get('settings-job-stop-mock-generate')
      && !registry.get('settings-job-stop-mock-failed'),
    `scan=${!!registry.get('settings-job-stop-mock-scan')} `
    + `generate=${!!registry.get('settings-job-stop-mock-generate')} `
    + `failed=${!!registry.get('settings-job-stop-mock-failed')}`);
  await enterFocusId('settings-job-stop-mock-scan');
  await enterFocusId('settings-job-stop-mock-scan');
  const mockRemoved = await waitFor(() => {
    const g = group('Server status');
    return g && !g.textContent.includes('Scanning metadata') ? g : null;
  }, 4000);
  check('R8b Test mode removes the sample job and contacts no server',
    !!mockRemoved && dialogText().includes('Test mode')
      && mockRemoved.textContent.includes('Generate gallery covers')
      && (await stopFetches()).length === 0,
    `removed=${!!mockRemoved} note=${dialogText().includes('Test mode')} `
    + `fetches=${(await stopFetches()).length}`);
}

// ── Run ─────────────────────────────────────────────────────
document.body.style.margin = '0';
document.getElementById('root').style.cssText =
  'height:100vh;display:flex;flex-direction:column;overflow:hidden;';

(async () => {
  try {
    await runStats();
    await runServer();
    await runScan();
    await runStop();
    check('view under test', true, 'settings-status');
    await finish();
  } catch (e) {
    results.push({
      name: 'HARNESS CRASHED',
      pass: false,
      detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
    });
    try { await finish(); } catch { /* nothing left to do */ }
  }
})();
