/**
 * Headless driver for the public-only update check.
 *
 * Run twice by sweep.sh: HARNESS_UPDATE_CHECK=1 (the public shape) and 0 (the
 * private shape). The gate is a build constant, so the two states cannot be
 * observed in one bundle and each run is its own claim:
 *
 *   on   the section, the header suffix and the rail dot; opt-in auto check,
 *        manual check, shared in-flight request, up-to-date and failure states,
 *        the 24 h rule and persistence.
 *   off  none of the above exists and no update request is ever made, even with
 *        persisted state that would otherwise show an update.
 *
 * Only the update URL is stubbed; every other fetch goes to the fake Stash
 * server. The app runs in Test mode, so no Stash server is needed at all.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { setSettings, getSettings } from '../../src/utils/settings.js';
import { UPDATE_AUTO_DELAY_MS } from '../../src/utils/updateCheck.js';

const LS_KEY = 'tvapp.settings.v1';
const APP = __APP_VERSION__;
const ARMED = __UPDATE_CHECK__;
const UPDATE_URL = __UPDATE_URL__;
const HOUR = 60 * 60 * 1000;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms = 4000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = pred();
    if (value) return value;
    await sleep(step);
  }
  return null;
}

const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});

// ── The update endpoint, stubbed ────────────────────────────
const realFetch = window.fetch.bind(window);
const updateCalls = [];
let stub = { tag: 'v99.0.0', status: 200, delay: 0 };
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (!UPDATE_URL || !url.startsWith(UPDATE_URL)) return realFetch(input, init);
  updateCalls.push({ url, options: init });
  if (stub.delay) await sleep(stub.delay);
  if (stub.status !== 200) return new Response('no', { status: stub.status });
  return new Response(JSON.stringify({ tag_name: stub.tag }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// ── DOM handles ─────────────────────────────────────────────
const dialog = () => document.querySelector('[role="dialog"]');
const dialogText = () => dialog()?.textContent || '';
const buttons = () => [...document.querySelectorAll('[role="dialog"] button')];
const byLabel = (label) => buttons().find(b => b.textContent.trim() === label);

// The header's version div, the only one whose text starts with the version.
const versionLine = () => [...document.querySelectorAll('[role="dialog"] header div')]
  .map(d => d.textContent.trim())
  .find(t => t.startsWith(`v${APP}`)) || '';

const settingsRow = () => registry.get('nav-settings')?.el || null;
const railDot = () => {
  const row = settingsRow();
  if (!row) return null;
  return [...row.querySelectorAll('span[aria-hidden="true"]')]
    .find(s => Math.round(s.offsetWidth) === 7) || null;
};
const railSaysUpdate = () => (settingsRow()?.textContent || '').includes('Update available');

const stored = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
};

// ── Remote input and mounting ───────────────────────────────
async function enterFocusId(id, settle = 180) {
  const entry = registry.get(id);
  if (!entry) throw new Error(`no focusable "${id}" (have: ${[...registry.keys()].join(' | ')})`);
  entry.el.focus();
  await sleep(50);
  entry.el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await sleep(settle);
}

let root = null;
async function mount() {
  const host = document.getElementById('root');
  if (root) root.unmount();
  host.replaceChildren();
  root = createRoot(host);
  root.render(<App />);
  await waitFor(() => !!registry.get('nav-settings'), 6000);
  await sleep(200);
}
async function unmount() {
  if (root) root.unmount();
  root = null;
  await sleep(100);
}

async function openSettings() {
  const row = registry.get('nav-settings');
  if (!row) throw new Error('the rail has no Settings row');
  row.el.click();
  await waitFor(() => !!dialog(), 4000);
  await sleep(200);
}
async function closeSettings() {
  byLabel('Cancel')?.click();
  await waitFor(() => !dialog(), 3000);
  await sleep(150);
}

// ═══════════════════════════════════════════════════════════
// Public shape
// ═══════════════════════════════════════════════════════════
async function runArmed() {
  check('U0 the armed build carries the flag and the endpoint',
    ARMED === true && UPDATE_URL === 'https://updates.test/latest',
    `armed=${ARMED} url="${UPDATE_URL}"`);

  setSettings({
    useMock: true,
    onboarded: 'test',
    updateCheckEnabled: false,
    lastUpdateCheckAt: 0,
    updateLatestVersion: '',
  });
  await mount();

  // ── U1  Opt-in ──────────────────────────────────────────
  await sleep(UPDATE_AUTO_DELAY_MS + 700);
  check('U1 no automatic check while the toggle is off',
    updateCalls.length === 0, `${updateCalls.length} calls`);

  // ── U2  The row, before any check ───────────────────────
  await openSettings();
  const toggleEl = () => registry.get('settings-update-toggle')?.el || null;
  check('U2 the Updates row is present with the check off and nothing checked',
    !!toggleEl() && !!registry.get('settings-update-check')
      && toggleEl().textContent.trim() === 'Off'
      && toggleEl().getAttribute('aria-pressed') === 'false'
      && dialogText().includes('Not checked yet.'),
    `toggle="${toggleEl()?.textContent.trim()}" `
    + `pressed=${toggleEl()?.getAttribute('aria-pressed')} `
    + `unchecked=${dialogText().includes('Not checked yet.')}`);
  check('U2 nothing marks the rail or the header before a check',
    !versionLine().includes('available') && !railSaysUpdate() && !railDot(),
    `header="${versionLine()}" rail="${(settingsRow()?.textContent || '').trim()}"`);

  // ── U3  Enabling runs the automatic check ───────────────
  stub = { tag: 'v99.0.0', status: 200, delay: 0 };
  await enterFocusId('settings-update-toggle');
  const autoFired = await waitFor(() => updateCalls.length === 1, UPDATE_AUTO_DELAY_MS + 4000);
  const autoStatus = await waitFor(() => dialogText().includes('v99.0.0 is available.'), 3000);
  const call = updateCalls[0];
  check('U3 enabling the toggle runs one automatic check',
    !!autoFired && updateCalls.length === 1, `${updateCalls.length} calls`);
  check('U3 the request is a bare GET for the release JSON, no auth and no body',
    !!call && call.url === UPDATE_URL && call.options.method === 'GET'
      && call.options.headers?.Accept === 'application/vnd.github+json'
      && !call.options.headers?.Authorization && !call.options.body,
    call ? JSON.stringify(call.options) : 'no call');
  check('U3 available is shown in the row, the header and the rail dot',
    !!autoStatus && versionLine().includes('v99.0.0 available')
      && railSaysUpdate() && !!railDot(),
    `row=${!!autoStatus} header="${versionLine()}" rail="${railSaysUpdate()}" dot=${!!railDot()}`);
  check('U3 the toggle, the timestamp and the latest version are persisted',
    getSettings().updateCheckEnabled === true
      && getSettings().updateLatestVersion === '99.0.0'
      && getSettings().lastUpdateCheckAt > 0
      && stored()?.updateCheckEnabled === true
      && stored()?.updateLatestVersion === '99.0.0'
      && stored()?.lastUpdateCheckAt === getSettings().lastUpdateCheckAt,
    `store=${getSettings().updateCheckEnabled}/${getSettings().updateLatestVersion}/`
    + `${getSettings().lastUpdateCheckAt > 0} saved=${stored()?.updateCheckEnabled}/`
    + `${stored()?.updateLatestVersion}`);

  // ── U4  Two rapid presses share one request ─────────────
  // The answer is held long enough that the second press lands in flight.
  stub = { tag: 'v99.0.0', status: 200, delay: 1000 };
  const beforeRapid = updateCalls.length;
  await enterFocusId('settings-update-check', 0);
  await enterFocusId('settings-update-check', 0);
  await waitFor(() => updateCalls.length > beforeRapid, 3000);
  await waitFor(() => !byLabel('Checking…'), 5000);
  await sleep(200);
  check('U4 two rapid presses share one request and keep the result',
    updateCalls.length === beforeRapid + 1 && dialogText().includes('v99.0.0 is available.'),
    `${beforeRapid} → ${updateCalls.length}`);

  // ── U5  Installed version equals the latest release ─────
  stub = { tag: `v${APP}`, status: 200, delay: 0 };
  await enterFocusId('settings-update-check');
  const upToDate = await waitFor(() => dialogText().includes('Up to date.'), 3000);
  check('U5 an equal release reads as up to date and clears both marks',
    !!upToDate && !versionLine().includes('available')
      && !railSaysUpdate() && !railDot()
      && getSettings().updateLatestVersion === APP,
    `status=${!!upToDate} header="${versionLine()}" rail=${railSaysUpdate()} `
    + `dot=${!!railDot()} latest=${getSettings().updateLatestVersion}`);

  // ── U6  A failure is reported and still stamped ─────────
  stub = { tag: 'v99.0.0', status: 403, delay: 0 };
  const lastAtBefore = getSettings().lastUpdateCheckAt;
  await sleep(20);
  await enterFocusId('settings-update-check');
  const failed = await waitFor(
    () => dialogText().includes("Couldn't check for updates. GitHub returned an error."), 3000);
  check('U6 a failed check is reported and its timestamp written anyway',
    !!failed && getSettings().lastUpdateCheckAt > lastAtBefore
      && getSettings().updateLatestVersion === APP
      && stored()?.lastUpdateCheckAt === getSettings().lastUpdateCheckAt,
    `status=${!!failed} advanced=${getSettings().lastUpdateCheckAt > lastAtBefore} `
    + `latest=${getSettings().updateLatestVersion}`);

  // ── U7  Not retried at the next launch ──────────────────
  await closeSettings();
  await unmount();
  await mount();
  const afterRelaunch = updateCalls.length;
  await sleep(UPDATE_AUTO_DELAY_MS + 700);
  check('U7 a check less than 24 hours old is not repeated at launch',
    updateCalls.length === afterRelaunch, `${afterRelaunch} → ${updateCalls.length}`);

  // ── U8  Due after 24 hours ──────────────────────────────
  stub = { tag: 'v99.1.0', status: 200, delay: 0 };
  const beforeDue = updateCalls.length;
  setSettings({ lastUpdateCheckAt: Date.now() - 25 * HOUR });
  const dueFired = await waitFor(() => updateCalls.length === beforeDue + 1,
    UPDATE_AUTO_DELAY_MS + 4000);
  const dueStored = await waitFor(() => getSettings().updateLatestVersion === '99.1.0', 3000);
  check('U8 a check older than 24 hours runs automatically at launch',
    !!dueFired && !!dueStored,
    `${beforeDue} → ${updateCalls.length} latest=${getSettings().updateLatestVersion}`);

  // ── U9  Manual check with the automatic one off ─────────
  await openSettings();
  check('U9 the toggle survived the relaunch',
    toggleEl()?.textContent.trim() === 'On'
      && toggleEl()?.getAttribute('aria-pressed') === 'true' && !!railDot(),
    `toggle="${toggleEl()?.textContent.trim()}" dot=${!!railDot()}`);
  await enterFocusId('settings-update-toggle');
  const beforeManual = updateCalls.length;
  await enterFocusId('settings-update-check');
  const manualDisabled = await waitFor(() => updateCalls.length === beforeManual + 1, 3000);
  check('U9 Check now still works with the automatic check off',
    !!manualDisabled && getSettings().updateCheckEnabled === false,
    `checked=${!!manualDisabled} enabled=${getSettings().updateCheckEnabled}`);

  check('U10 no error was raised during the run',
    errors.length === 0, errors.length ? errors.slice(-2).join(' | ') : 'none');
}

// ═══════════════════════════════════════════════════════════
// Private shape
// ═══════════════════════════════════════════════════════════
async function runOff() {
  check('G0 the private build has no flag and no endpoint',
    ARMED === false && UPDATE_URL === '', `armed=${ARMED} url="${UPDATE_URL}"`);

  // Persisted state that would otherwise demand a check and show a version.
  setSettings({
    useMock: true,
    onboarded: 'test',
    updateCheckEnabled: true,
    lastUpdateCheckAt: 0,
    updateLatestVersion: '99.9.9',
  });
  await mount();
  await sleep(UPDATE_AUTO_DELAY_MS + 700);

  await openSettings();
  check('G1 even with the state on, the Updates row is absent',
    !registry.get('settings-update-toggle') && !registry.get('settings-update-check')
      && !byLabel('Check now') && !dialogText().includes('Updates'),
    `buttons: ${buttons().map(b => b.textContent.trim()).join(' | ').slice(0, 160)}`);
  check('G1 a newer stored version paints nothing',
    !versionLine().includes('available') && !railSaysUpdate() && !railDot(),
    `header="${versionLine()}" rail=${railSaysUpdate()} dot=${!!railDot()}`);
  check('G1 no update request is made',
    updateCalls.length === 0, `${updateCalls.length} calls`);

  check('G2 no error was raised during the run',
    errors.length === 0, errors.length ? errors.slice(-2).join(' | ') : 'none');
}

async function finish() {
  await realFetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await realFetch('/done', { method: 'POST' });
}

document.body.style.margin = '0';
document.getElementById('root').style.cssText =
  'height:100vh;display:flex;flex-direction:column;overflow:hidden;';

(ARMED ? runArmed() : runOff())
  .then(finish)
  .catch(async (e) => {
    check('HARNESS CRASHED', false,
      String(e && e.stack ? e.stack.split('\n')[0] : e));
    try { await finish(); } catch { /* nothing left to do */ }
  });
