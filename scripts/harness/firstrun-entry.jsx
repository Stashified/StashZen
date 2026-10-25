/**
 * Headless driver for the first-run gate and its optional PIN step.
 *
 * FirstRun does not just draw a setup screen: App must not mount until the
 * question is answered, or a device with no server fires a library request at a
 * dead URL. The observable is `/graphqlcalls`, which records every operation
 * (not just findScenes): A = gate closed sends nothing, B = gate opened mounts
 * App and persists, D = live mode sends traffic, so the empty log is trustworthy.
 * A5 repeats A4 with a working endpoint — only the gate can keep that log empty.
 *
 * PIN: Skip holds a pending patch and opens the step, so B2/B3 assert storage,
 * not the screen; C asserts the commit on decline. G sets a real PIN and
 * requires the app to come up unlocked (AppLock reads isLockSet() once at mount).
 * Measured deletion controls: early commit 12 red, no onDecline 2, no re-run
 * guard 1, vertical brand lockup 1.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import FirstRun from '../../src/components/FirstRun.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { setSettings, getSettings } from '../../src/utils/settings.js';
import { isLockSet, clearPin } from '../../src/utils/appLock.js';

const PORT = window.__PORT__;
const LS_KEY = 'tvapp.settings.v1';
const LOCK_KEY = 'tvapp.lock.v1';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const calls = () => fetch('/graphqlcalls').then(r => r.json()).catch(() => []);
const clearLog = () => fetch('/clear', { method: 'POST' }).catch(() => {});

/** Patch the fake server's behaviour, as every other driver does. */
async function setMode(patch) {
  await fetch('/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

const registered = (id) => !!registry.get(id);

/**
 * Whether a registered id is still *on screen*. Separate from `registered()`
 * because between React removing the element and flushing passive cleanups,
 * the registry entry can point at a detached node.
 */
const live = (id) => {
  const el = registry.get(id)?.el;
  return !!el && document.contains(el);
};

/** The setup screen's own dialog, found in the DOM rather than the registry. */
const setupDialog = () =>
  document.querySelector('[role="dialog"][aria-label="Connect to Stash"]');

/**
 * PinPad's dialog. Titles are 'Set a PIN', 'Confirm PIN' and, on the lock
 * screen, 'Enter PIN'.
 */
const padDialog = () =>
  [...document.querySelectorAll('[role="dialog"]')]
    .find(d => /PIN$/.test(d.getAttribute('aria-label') || '')) || null;

/**
 * A pad button by announced label. The pad namespaces ids with a `useId()`, so
 * they are not addressable; digits carry an aria-label, the decline button does
 * not, so its text is the fallback.
 */
const padButton = (label) => {
  const d = padDialog();
  if (!d) return null;
  return [...d.querySelectorAll('button')]
    .find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === label) || null;
};

const pressPadButton = (label) => {
  const b = padButton(label);
  if (!b) throw new Error(`no pad button labelled ${label}`);
  b.click();
};

/** Type a PIN. The pad auto-submits on the last digit — no separate OK. */
const enterPin = (pin) => { for (const digit of pin) pressPadButton(digit); };

/** The persisted blob, read the way the next launch would read it. */
const stored = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
};

const storedLock = () => {
  try { return localStorage.getItem(LOCK_KEY); }
  catch { return null; }
};

/** A real press of a registered element — the button's own onClick handler. */
function press(id) {
  const el = registry.get(id)?.el;
  if (!el) throw new Error(`nothing registered as ${id}`);
  el.click();
}

/** Back, as the remote sends it: a window keydown carrying legacy keyCode. */
function pressBack() {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    keyCode: 10009, bubbles: true, cancelable: true,
  }));
}

/**
 * Wipe the device back to never-set-up: no settings, no PIN. Emptied through
 * the stores, since their in-memory copies are what the components read.
 */
function freshDevice() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  clearPin();
  setSettings({
    stashUrl: '',              // clears hasSavedEndpoint, the inference that
    stashKey: '',              // would otherwise mark this device onboarded
    onboarded: null,
    setupRequested: false,
    useMock: false,
  });
}

async function run() {
  freshDevice();
  await clearLog();

  const root = createRoot(document.getElementById('root'));
  root.render(<FirstRun><App /></FirstRun>);

  // ── A: the gate is closed ───────────────────────────────
  await sleep(1500);

  check('A1 the setup screen is on screen',
    !!setupDialog() && registered('firstrun-url'),
    `dialog ${!!setupDialog()}, url field ${registered('firstrun-url')}`);

  check('A2 the app itself is not mounted',
    !registered('nav-home') && !registered('ctrl-filter'),
    `nav-home ${registered('nav-home')}, ctrl-filter ${registered('ctrl-filter')}, `
    + `registry size ${registry.size}`);

  // `stashUrl` itself falls back to the env default, so a screen that prefilled
  // from the store would show `http://localhost:9999` — wrong on a TV, yet it
  // looks like a real answer. Prefill must follow `hasSavedEndpoint`.
  const urlInput = registry.get('firstrun-url')?.el?.querySelector('input');
  check('A3 a fresh device is not handed a placeholder address to clear',
    urlInput?.value === '',
    `field value ${JSON.stringify(urlInput?.value)}`);

  // ── A6/A7: the brand lockup ─────────────────────────────
  // Name and tagline share a `flex-wrap` row; a wrap splits them onto two lines,
  // so A7 asserts overlapping vertical extents. Found by exact text (hashed CSS).
  const leafWithText = (t) => [...setupDialog().querySelectorAll('span, p, div')]
    .find(el => el.children.length === 0 && el.textContent.trim() === t) || null;

  const nameEl = leafWithText('StashZen');
  const tagEl = leafWithText('Private media, made simple.');
  check('A6 the setup screen names the product and its tagline',
    !!nameEl && !!tagEl,
    `name ${!!nameEl}, tagline ${!!tagEl}`);

  const nr = nameEl?.getBoundingClientRect();
  const tr = tagEl?.getBoundingClientRect();
  // Same line means their vertical extents overlap. On a wrap they do not:
  // the tagline's top lands at or below the wordmark's bottom.
  check('A7 the name and tagline share a line rather than wrapping',
    !!nr && !!tr && nr.top < tr.bottom && tr.top < nr.bottom,
    nr && tr
      ? `name ${Math.round(nr.top)}–${Math.round(nr.bottom)}, `
        + `tagline ${Math.round(tr.top)}–${Math.round(tr.bottom)}`
      : 'not measurable');

  const phaseA = await calls();
  check('A4 no request of any kind was sent',
    phaseA.length === 0,
    `logged: ${JSON.stringify(phaseA)}`);

  // A4 is only as good as this: on an empty URL the app fails its own config
  // check and sends nothing whatever the gate does. With a working endpoint the
  // empty log means "not mounted" rather than "nothing to connect to".
  setSettings({ stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });
  await sleep(900);

  const phaseA2 = await calls();
  check('A5 still nothing, with a working endpoint configured',
    phaseA2.length === 0 && !registered('nav-home'),
    `logged: ${JSON.stringify(phaseA2)}, nav-home ${registered('nav-home')}`);

  // ── B: Skip reaches the PIN step, and commits nothing ───
  // Pressed by id, so the check is on the same path the remote takes.
  let skipped = false;
  try { press('firstrun-skip'); skipped = true; }
  catch (e) { check('B0 the Skip button is reachable from the D-pad', false, String(e.message)); }

  await sleep(800);

  if (skipped) {
    check('B1 Skip opens the PIN step, and the connect card is gone',
      !!padDialog() && !setupDialog() && !live('firstrun-url'),
      `pad ${!!padDialog()}, setup dialog ${!!setupDialog()}, `
      + `url field live ${live('firstrun-url')} (registered ${registered('firstrun-url')})`);

    // The structural claim: committing at Skip would mount App behind the PIN
    // step and still pass every screen-level check. `onboarded` is persisted as
    // null rather than absent, so both halves are `== null`.
    check('B2 nothing is committed while the flow is still open',
      getSettings().onboarded == null && stored().onboarded == null
        && getSettings().useMock === false,
      `in memory onboarded ${JSON.stringify(getSettings().onboarded)}, `
      + `stored ${JSON.stringify(stored().onboarded)}, useMock ${getSettings().useMock}`);

    check('B3 opening the PIN step writes no PIN',
      !isLockSet() && storedLock() === null,
      `isLockSet ${isLockSet()}, storage ${JSON.stringify(storedLock())}`);

    check('B4 the gate is still shut behind the step',
      !registered('nav-home'),
      `nav-home ${registered('nav-home')}`);
  }

  // ── C: declining the PIN step finishes the flow ─────────
  let declined = false;
  try { pressPadButton('Not now'); declined = true; }
  catch (e) { check('C0 the decline action is on the pad', false, String(e.message)); }

  await sleep(1200);

  if (declined) {
    check('C1 declining closes the flow and mounts the app',
      !setupDialog() && !padDialog() && registered('nav-home'),
      `setup ${!!setupDialog()}, pad ${!!padDialog()}, nav-home ${registered('nav-home')}`);

    // The "ask once" promise: without `onboarded` in persistToStorage the gate
    // works this session and returns next launch, which on a TV means retyping
    // a URL with the on-screen keyboard every time the app starts.
    check('C2 the held patch was committed on the way out',
      getSettings().onboarded === 'test' && stored().onboarded === 'test',
      `in memory ${JSON.stringify(getSettings().onboarded)}, `
      + `stored ${JSON.stringify(stored().onboarded)}`);

    check('C3 sample data is what was chosen',
      getSettings().useMock === true && stored().useMock === true,
      `useMock in memory ${getSettings().useMock}, stored ${stored().useMock}`);

    check('C4 declining left no PIN behind',
      !isLockSet() && storedLock() === null,
      `isLockSet ${isLockSet()}, storage ${JSON.stringify(storedLock())}`);

    // Sample data is generated locally. If this fires, "Test mode" has started
    // reaching for a server it does not have.
    const phaseC = await calls();
    check('C5 sample data is offline',
      phaseC.length === 0, `logged: ${JSON.stringify(phaseC)}`);
  }

  // ── D: control — the same log does see traffic ──────────
  // Everything except the mode held fixed, so the only difference between A5
  // and D1 is whether the gate is open.
  setSettings({
    useMock: false,
    onboarded: 'live',
    stashUrl: `http://127.0.0.1:${PORT}`,
    stashKey: 'harness',
  });

  await sleep(1500);

  const phaseD = await calls();
  check('D1 with the gate open, the app does talk to the server',
    phaseD.length > 0,
    `logged: ${JSON.stringify(phaseD)} — A4 is only meaningful because this is non-empty`);

  check('D2 the live library request is among them',
    phaseD.some(op => /findScenes/i.test(op)),
    `logged: ${JSON.stringify(phaseD)}`);

  check('D3 the gate stays open once answered',
    !setupDialog() && registered('nav-home'),
    `dialog ${!!setupDialog()}, nav-home ${registered('nav-home')}`);

  // ── E: re-running setup, and backing out of it ──────────
  setSettings({ setupRequested: true });
  await sleep(500);

  check('E1 asking for setup again reopens the gate',
    !!setupDialog() && !registered('nav-home'),
    `dialog ${!!setupDialog()}, nav-home ${registered('nav-home')}`);

  pressBack();
  await sleep(800);

  check('E2 Back cancels the re-run and returns to the app',
    !setupDialog() && registered('nav-home'),
    `dialog ${!!setupDialog()}, nav-home ${registered('nav-home')}`);

  check('E3 cancelling did not disturb the saved connection',
    getSettings().onboarded === 'live' && getSettings().useMock === false
      && stored().onboarded === 'live',
    `onboarded ${getSettings().onboarded}, useMock ${getSettings().useMock}, `
    + `stored ${JSON.stringify(stored().onboarded)}`);

  // ── F: a re-run is not offered the PIN step ─────────────
  // It exists to fix a connection, and Settings already owns the PIN. Offered
  // here, a user fixing a typo would be walked through a keypad on the way.
  setSettings({ setupRequested: true });
  await sleep(500);
  try { press('firstrun-skip'); } catch { /* B0 already reports this path */ }
  await sleep(1000);

  check('F1 a re-run finishes in one step, with no PIN step',
    !padDialog() && registered('nav-home') && stored().onboarded === 'test',
    `pad ${!!padDialog()}, nav-home ${registered('nav-home')}, `
    + `stored onboarded ${JSON.stringify(stored().onboarded)}`);

  // ── G: a first run can actually set a PIN ───────────────
  freshDevice();
  await sleep(900);
  try { press('firstrun-skip'); } catch { /* reported by B0 */ }
  await sleep(700);

  check('G1 the PIN step is offered on Skip as well as Connect',
    !!padDialog(),
    `pad title ${JSON.stringify(padDialog()?.getAttribute('aria-label'))}`);

  try { enterPin('1234'); } catch (e) { check('G0 the digits are on the pad', false, String(e.message)); }
  await sleep(400);

  check('G2 a first entry advances to the confirm phase',
    /Confirm PIN/.test(padDialog()?.getAttribute('aria-label') || ''),
    `pad title ${JSON.stringify(padDialog()?.getAttribute('aria-label'))}`);

  try { enterPin('1234'); } catch { /* reported above */ }
  await sleep(1200);

  check('G3 the PIN was written and the flow finished',
    isLockSet() && !!storedLock() && registered('nav-home')
      && stored().onboarded === 'test',
    `isLockSet ${isLockSet()}, storage ${storedLock() ? 'present' : 'null'}, `
    + `nav-home ${registered('nav-home')}, stored ${JSON.stringify(stored().onboarded)}`);

  // AppLock reads isLockSet() once at mount and does not subscribe, so this PIN
  // takes effect next launch; `isLockSet()` alone would pass on a build that
  // demanded it immediately. The pad's absence is the half that matters.
  check('G4 the PIN does not lock the user out of the launch they set it on',
    !padDialog() && !setupDialog(),
    `pad ${!!padDialog()}, setup ${!!setupDialog()}`);

  // ── H: a mismatch restarts at phase one ─────────────────
  freshDevice();
  await sleep(900);
  try { press('firstrun-skip'); } catch { /* reported by B0 */ }
  await sleep(700);
  try { enterPin('1234'); } catch { /* reported by G2 */ }
  await sleep(400);
  try { enterPin('5678'); } catch { /* reported by G2 */ }
  await sleep(500);

  check('H1 a mismatch returns to the first entry, not to the confirm phase',
    /Set a PIN/.test(padDialog()?.getAttribute('aria-label') || ''),
    `pad title ${JSON.stringify(padDialog()?.getAttribute('aria-label'))}`);

  // Staying on 'confirm' would loop forever against a first entry the user
  // mistyped, which is the reason this resets rather than retries.
  check('H2 the mismatch wrote no PIN and did not finish the flow',
    !isLockSet() && storedLock() === null && !registered('nav-home')
      && getSettings().onboarded == null,
    `isLockSet ${isLockSet()}, storage ${JSON.stringify(storedLock())}, `
    + `nav-home ${registered('nav-home')}, onboarded ${JSON.stringify(getSettings().onboarded)}`);

  // ── I: Back from the PIN step goes back a step ──────────
  // Not out of setup: on a first run there is nothing behind this to return
  // to, and the flow must still be finishable afterwards.
  pressBack();
  await sleep(700);

  check('I1 Back from the PIN step returns to the connection step',
    !!setupDialog() && !padDialog() && live('firstrun-url'),
    `setup ${!!setupDialog()}, pad ${!!padDialog()}, url field live ${live('firstrun-url')}`);

  check('I2 and nothing was committed on the way back',
    getSettings().onboarded == null && stored().onboarded == null,
    `in memory ${JSON.stringify(getSettings().onboarded)}, `
    + `stored ${JSON.stringify(stored().onboarded)}`);

  // The cycle this closes: Back to connect, Skip forward again, and the step
  // returns. Without the decline action that is an unbreakable loop, so what
  // is asserted is that the second visit can still be left.
  try { press('firstrun-skip'); } catch { /* reported by B0 */ }
  await sleep(700);
  try { pressPadButton('Not now'); } catch { /* reported by C0 */ }
  await sleep(1200);

  check('I3 the flow is still finishable after Back and forward again',
    registered('nav-home') && stored().onboarded === 'test' && !padDialog(),
    `nav-home ${registered('nav-home')}, stored ${JSON.stringify(stored().onboarded)}, `
    + `pad ${!!padDialog()}`);

  // ── J: Skip supersedes a Connect still in flight ────────
  // Connect disables itself while testing, not the screen, so Skip stays live;
  // a late answer must belong to the decision current when it was asked for.
  await setMode({ connection: 'slow' });
  clearPin();
  setSettings({
    stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness',
    onboarded: null, setupRequested: false, useMock: false,
  });
  await sleep(900);

  check('J0 setup is open with the saved endpoint prefilled',
    !!setupDialog() && live('firstrun-url'),
    `setup ${!!setupDialog()}, url live ${live('firstrun-url')}`);

  let lateConnect = false;
  try { press('firstrun-connect'); lateConnect = true; }
  catch (e) { check('J0 the Connect button is reachable', false, String(e.message)); }
  await sleep(200);   // the request is in flight; the fake is holding it
  let skipDuringConnect = false;
  try { press('firstrun-skip'); skipDuringConnect = true; }
  catch (e) { check('J0b the Skip button is reachable', false, String(e.message)); }
  await sleep(300);

  check('J1 Skip is still reachable while Connect is busy',
    lateConnect && skipDuringConnect && !!padDialog(),
    `connect ${lateConnect}, skip ${skipDuringConnect}, pad ${!!padDialog()}`);

  // The held answer lands here. Nothing on screen may change: the choice was
  // made after the question was asked.
  await sleep(2200);
  check('J2 the late Connect answer does not change the step on screen',
    !!padDialog() && !setupDialog(),
    `pad ${!!padDialog()}, setup ${!!setupDialog()}`);

  try { pressPadButton('Not now'); } catch { /* C0 reports the pad */ }
  await sleep(1200);

  // The held patch was live before Skip replaced it; a late answer that
  // overwrote it would commit "connected" for a user who chose not to. The
  // visible flow is identical either way.
  check('J3 the flow commits Skip, not the Connect that answered late',
    getSettings().onboarded === 'test' && getSettings().useMock === true
      && stored().onboarded === 'test' && stored().useMock === true,
    `in memory ${getSettings().onboarded}/${getSettings().useMock}, `
    + `stored ${JSON.stringify(stored().onboarded)}/${stored().useMock}`);

  check('J4 the late answer did not mount the live app',
    registered('nav-home') && !padDialog() && !setupDialog(),
    `nav-home ${registered('nav-home')}, pad ${!!padDialog()}`);

  // ── K: StrictMode's double mount must not disarm the screen ─
  // StrictMode tears the effect down and mounts it again against the same refs;
  // a cleanup-only latch stays false and every Test/Connect silently returns null.
  await setMode({ connection: 'ok' });
  root.unmount();
  await sleep(200);   // let unmount's passive cleanups flush the registry
  await clearLog();
  clearPin();
  setSettings({
    stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness',
    onboarded: null, setupRequested: false, useMock: false,
  });

  const strictRoot = createRoot(document.getElementById('root'));
  strictRoot.render(<StrictMode><FirstRun><div /></FirstRun></StrictMode>);
  await sleep(900);

  check('K0 the setup screen survives the StrictMode double mount',
    !!setupDialog() && live('firstrun-url'),
    `setup ${!!setupDialog()}, url live ${live('firstrun-url')}`);

  try { press('firstrun-test'); } catch (e) { check('K0b the Test button is reachable', false, String(e.message)); }
  await sleep(1000);
  const statusLine = setupDialog()?.querySelector('[role="status"]');
  check('K1 a Test still answers after the double mount',
    !!statusLine && /Connected — Stash v0\.31\.1-harness/.test(statusLine.textContent),
    `status ${JSON.stringify(statusLine?.textContent)}`);

  check('K2 ...and the button is not left stuck on Testing…',
    /Test connection/.test(registry.get('firstrun-test')?.el?.textContent || ''),
    `button ${JSON.stringify(registry.get('firstrun-test')?.el?.textContent)}`);
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

document.body.style.margin = '0';

run().then(finish).catch(async (e) => {
  results.push({
    name: 'HARNESS CRASHED',
    pass: false,
    detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
  });
  try { await finish(); } catch { /* nothing left to do */ }
});
