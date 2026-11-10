/**
 * Headless driver for the connection banner: an unreachable server, a Retry
 * that fails, and the one that recovers.
 *
 * `transport: "down"` in the fake server closes the socket on every /graphql
 * POST with no reply, so the app sees a network failure rather than an HTTP
 * status; /mode stays reachable, which lets one run flip the outage on and off.
 *
 * The banner's own focus is the observable for "the D-pad can reach Retry", and
 * the registry's current id is the observable for "the cursor came back". The
 * last probe is the classification: a GraphQL-level failure is an answer from a
 * reachable server and must not raise the banner.
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

// A predicate that has to read the fake's log first; `waitFor` would see the
// Promise and call it satisfied.
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
  await sleep(180);
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
const bodyText = () => document.body.textContent || '';
const banner = () => document.querySelector('[role="alert"]');
const bannerUp = () => !!banner() && live('connection-retry');
const railActive = () =>
  [...(document.querySelector('nav[aria-label="Main navigation"]')?.querySelectorAll('button') ?? [])]
    .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || '(none)';

async function run() {
  const booted = await waitFor(() => registry.has('nav-scenes') && registry.has('nav-home'));
  check('C0 the app boots against the fake server', booted,
    `${registry.size} focusable ids; errors: ${errorTail()}`);

  focus('nav-scenes');
  await tapEnter();
  await waitFor(() => railActive().toLowerCase() === 'scenes' && live('video-1'));
  check('C0b the Scenes listing loads before the outage', live('video-1'),
    `rail=${railActive()} video-1=${live('video-1')}`);

  // ── The outage ──────────────────────────────────────────
  // Focus the tab row first: the banner remembers the element that had the
  // cursor when the server went away.
  await clearLogs();
  focus('nav-scenes');
  await sleep(120);
  await setMode('transport', 'down');
  await tapEnter();
  const appeared = await waitFor(bannerUp, 6000);
  check('C1 an unreachable server raises the banner', appeared,
    `banner=${!!banner()} text=${JSON.stringify(bodyText().slice(0, 120))}`);
  check('C1b it names the problem and the failure',
    appeared && bodyText().includes('Cannot reach the Stash server')
      && bodyText().includes('Check the URL and that the TV is on the same network'),
    JSON.stringify(banner()?.textContent?.slice(0, 160) ?? ''));
  const owned = await waitFor(() => getCurrentFocusId() === 'connection-retry', 2000);
  check('C1c the Retry button owns the cursor, so the D-pad can reach it',
    owned, `focus=${getCurrentFocusId()}`);

  // ── Retry while it is still down ────────────────────────
  focus('connection-retry');
  await sleep(80);
  await tapEnter();
  const failed = await waitFor(() => bodyText().includes('Still unreachable'), 6000);
  check('C2 a Retry that fails says so', failed,
    JSON.stringify(banner()?.textContent?.slice(0, 200) ?? 'banner gone'));
  // The rows on screen are the stale page-1 seed, kept while the fresh page 1
  // retries; the failure is the banner's, not the grid's.
  check('C2b the banner stays up after a failed Retry', bannerUp(),
    `banner=${bannerUp()} rows=${live('video-1')}`);
  check('C2c and the cursor stays on the button to try again',
    getCurrentFocusId() === 'connection-retry', `focus=${getCurrentFocusId()}`);

  // ── The retry that recovers ─────────────────────────────
  await setMode('transport', 'ok');
  await clearLogs();
  focus('connection-retry');
  await sleep(80);
  await tapEnter();
  const gone = await waitFor(() => !bannerUp(), 8000);
  const rowsBack = await waitFor(() => live('video-1'), 8000);
  check('C3 a Retry against a healthy server clears the banner', gone, `banner=${bannerUp()}`);
  check('C3b and the page refetches the rows that failed', rowsBack,
    `rows=${live('video-1')} rail=${railActive()}`);
  const calls = await getJSON('/requests');
  check('C3c the refetch went to the wire, not the list cache',
    calls.some(r => r.page === 1),
    `${calls.length} findScenes request(s)`);

  // ── The cursor comes back ───────────────────────────────
  const restored = await waitFor(() => getCurrentFocusId() === 'nav-scenes', 4000);
  check('C4 the cursor returns to where the outage caught it',
    restored, `focus=${getCurrentFocusId()} active=${document.activeElement?.tagName}`);
  check('C4b it is not left on <body>', document.activeElement !== document.body,
    `active=${document.activeElement?.tagName ?? 'null'}`);

  // ── A server answer is not a connection problem ─────────
  // `findScenes: fail` replies HTTP 200 with a GraphQL error: the server is
  // reachable, the query is not. The banner must stay away.
  await setMode('findScenes', 'fail');
  await clearLogs();
  focus('nav-scenes');
  await sleep(100);
  await tapEnter();
  const hit = await waitForAsync(async () => (await getJSON('/requests')).length > 0, 6000);
  // Watch across the 3 s page-1 retry, so a late raise is caught too.
  let raised = false;
  for (let i = 0; i < 80 && !raised; i += 1) {
    raised = bannerUp();
    if (!raised) await sleep(50);
  }
  check('C5 a GraphQL failure is an answer, not an outage',
    hit && !raised,
    `request=${hit} banner=${raised} text=${JSON.stringify(bodyText().slice(0, 120))}`);

  await setMode('findScenes', 'ok');
  focus('nav-scenes');
  await sleep(100);
  await tapEnter();
  const healthy = await waitFor(() => live('video-1') && !bannerUp(), 10000);
  check('C6 the page recovers once the query is fixed', healthy,
    `rows=${live('video-1')} banner=${bannerUp()}`);

  check('C7 the whole run left no uncaught error', errors.length === 0, errorTail());
}

async function finish() {
  await fetch(`http://127.0.0.1:${PORT}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch(`http://127.0.0.1:${PORT}/done`, { method: 'POST' });
}

const root = document.getElementById('root');
document.body.style.margin = '0';

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
