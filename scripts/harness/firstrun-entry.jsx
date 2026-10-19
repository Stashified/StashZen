/**
 * Headless driver for the first-run gate (0.8.0's P0) and its optional PIN
 * step (0.12.0's P5).
 *
 * The original claim is negative, and that is what shapes this file. FirstRun
 * does not say "show a setup screen"; it says *the app is not mounted until the
 * question is answered*, so that a device with no server configured does not
 * fire a library request at a URL nothing is listening on and then render the
 * failure. A driver that only asserted "the setup screen appeared" would pass on
 * a build that drew it over a fully-mounted App, which is exactly the mistake
 * AppLock's header warns about and the one worth catching.
 *
 * So the observable is the server's own request log. `no request of any kind`
 * is asserted against `/graphqlcalls`, which records every operation before
 * dispatch — not `/requests`, which is only findScenes and would miss whichever
 * operation a future page happened to fetch first.
 *
 * The control is in two halves, because "nothing was logged" and "the log is
 * broken" look identical:
 *
 *   A  gate closed  → zero calls, no App in the registry
 *   B  gate opened  → App mounts, the answer is written to storage
 *   D  live mode    → calls DO appear, so the log in A can see traffic
 *
 * A is in two steps for a reason found by the control experiment rather than
 * by reasoning. With a fresh device — no endpoint saved — deleting the gate
 * left every "nothing was sent" check green: the app mounted, failed its own
 * config check on an empty URL, and sent nothing, so an empty log meant
 * "nothing to connect to" and not "not mounted". A5 repeats A4 with a working
 * endpoint in the store, where the only thing that can keep the log empty is
 * the gate. Control: delete `if (!active) return children` and A1, A2, A5, B0
 * and D1 all go red.
 *
 * ── P5, and what it changed here ─────────────────────────────────────────
 *
 * The PIN step broke B's premise rather than merely adding to it. Skip used to
 * commit `onboarded` and mount the app; it now holds a pending patch and opens
 * a second step. So B asserts the *holding*, which is the phase's whole
 * structural claim, and C asserts the commit happens when the step is declined.
 *
 * The deferred commit is the thing with no visible symptom until it is wrong:
 * a build that committed at Connect/Skip would pass every "the app works"
 * check and still be broken, because abandoning the flow midway would leave
 * the device onboarded with a connection nobody finished entering. B2 and B3
 * are that assertion, and they are why B checks storage rather than the screen.
 *
 * G is the end-to-end pass — a real PIN, entered twice, and the app coming up
 * *unlocked* with a PIN set. That last part is the one that would regress
 * silently: AppLock reads `isLockSet()` once at mount and does not subscribe,
 * so a PIN set during this flow must not eject the user to a keypad. Asserting
 * `isLockSet() === true` alone would pass on a build that locked them out
 * immediately, so it is asserted together with "no pad on screen".
 *
 * ── Controls, measured rather than asserted ──────────────────────────────
 *
 * Three deletions, each run against the real driver. 30/30 is the baseline.
 *
 * | Deleted | Measured |
 * |---|---|
 * | The deferral — `advance` commits as it used to | **12 red**: B1, B2, B4, C0, both G, both H, both I, and F1 |
 * | `onDecline` on the step | **2 red**: C0, I3 |
 * | The `if (!isFirstRun)` guard in `advance` | **1 red**: F1 |
 * | `flex-direction: column` on the brand lockup | **1 red**: A7 — and A6 staying green is the point of it |
 *
 * The first row is worth reading closely, because the *mechanism* is not the
 * one the claim suggests. Committing early does not merely skip the holding: it
 * sets `onboarded`, so `<FirstRun>` returns `children` and unmounts the entire
 * setup screen — **including the PIN step**. B1's detail says it outright:
 * `pad false`. The step does not appear at all. So the failure a user would
 * meet is not "my settings were saved too early", it is "the question I was
 * being asked vanished mid-sentence", which is a much better thing to have
 * found here than on a TV.
 *
 * Rows two and three are each a check earning its place: I3 is the only thing
 * standing behind the cycle claim, and F1 the only thing behind the re-run
 * guard.
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
 * Whether a registered id is still *on screen*.
 *
 * `useFocusable` does delete its entry on unmount (useFocusable.js:279), so
 * this and `registered()` agree by the time a check runs — B1's detail prints
 * both and they match. It is kept as a separate question because "is this on
 * screen" is what every use of it here actually means, and it is the one that
 * cannot be answered wrongly by a registry entry that is mid-teardown: the
 * effect cleanup is a passive effect, so between React removing the element
 * and flushing cleanups there is a window where the entry exists and points at
 * a detached node.
 */
const live = (id) => {
  const el = registry.get(id)?.el;
  return !!el && document.contains(el);
};

/** The setup screen's own dialog, found in the DOM rather than the registry. */
const setupDialog = () =>
  document.querySelector('[role="dialog"][aria-label="Connect to Stash"]');

/**
 * PinPad's dialog. Titles are 'Set a PIN', 'Confirm PIN' and — on the lock
 * screen, which is the negative case this is used for — 'Enter PIN'.
 */
const padDialog = () =>
  [...document.querySelectorAll('[role="dialog"]')]
    .find(d => /PIN$/.test(d.getAttribute('aria-label') || '')) || null;

/**
 * A button on the pad, by the label it announces.
 *
 * By aria-label rather than by registry id, because the pad namespaces its ids
 * with a `useId()` — `pin-key-:r7:1` and friends — which is not addressable
 * from outside. Digits carry an aria-label; the optional decline button does
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
 * Wipe the device back to never-set-up: no settings, no PIN.
 *
 * Emptied through the stores rather than by writing localStorage, because the
 * stores' in-memory copies are what the components read, and setting storage
 * alone would leave a pre-existing state in place while appearing to reset it.
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

  // An empty endpoint on a device that has never saved one. `stashUrl` itself
  // is never empty — it falls back to the env default — so a setup screen that
  // prefilled from the store rather than from `hasSavedEndpoint` would show
  // `http://localhost:9999` here, an address that is wrong on a TV and looks
  // like a real answer.
  const urlInput = registry.get('firstrun-url')?.el?.querySelector('input');
  check('A3 a fresh device is not handed a placeholder address to clear',
    urlInput?.value === '',
    `field value ${JSON.stringify(urlInput?.value)}`);

  // ── A6/A7: the brand lockup ─────────────────────────────
  // The 0.14.0 rename put the product's name and tagline on this screen, and
  // this is the only place in the app both appear. The name half is the rename
  // itself and would be caught by any human looking at the build; the tagline's
  // *layout* would not. It is a `flex-wrap: wrap` row, so at some width the two
  // halves silently split onto two lines — a wordmark above a stray sentence,
  // which reads as a mistake rather than as wrapping. Nothing else here would
  // notice, and the card is wide enough at 1920 that it will not reproduce by
  // accident.
  //
  // Found by exact text rather than by a class: CSS Modules hash the class
  // names, and a `data-testid` added purely for this would be a hook with no
  // other reader.
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

  // A4 above is only as good as this: it has to be run against a device that
  // *could* have reached the server. With an empty URL the app fails its own
  // config check and sends nothing whatever the gate does — which is what the
  // first version of this file measured, and it stayed green with the gate
  // deleted. Handing the same closed gate a working endpoint is what makes the
  // empty log mean "the app is not mounted" rather than "the app had nothing
  // to connect to".
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

    // The phase's structural claim. A version that committed at Skip would
    // close the gate here and mount the app behind the PIN step — and would
    // look fine, because every screen-level check would still be green.
    // `stored().onboarded` is null rather than absent — the store persists an
    // explicit whitelist, `onboarded` is on it, and its value here is null. So
    // both halves are `== null`; an `=== undefined` was the first draft's
    // mistake and went red against a correct build.
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

    // The "ask once" promise. This is the assertion that fails if `onboarded`
    // is ever left out of persistToStorage — the gate would work for the rest
    // of the session and reappear on the next launch, which on a TV means
    // re-entering a URL with an on-screen keyboard every time the app starts.
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

  // The one that would regress silently. AppLock reads isLockSet() once at
  // mount and deliberately does not subscribe, so a PIN set in this flow takes
  // effect on the NEXT launch. `isLockSet()` alone would be green on a build
  // that demanded the PIN immediately, throwing the user straight back to a
  // keypad the moment they finished setting it — so the pad's absence is the
  // half of this that matters.
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
  // Connect disables itself while testing, not the screen: Skip stays a live
  // button, so a slow answer and a later decision can both be in play. The
  // answer belongs to the decision that was current when it was asked for.
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

  // The decisive half. The held patch was live before Skip replaced it; if the
  // late answer overwrote it, finishing commits "connected" for a user who
  // explicitly chose not to. The visible flow is identical either way, which
  // is what makes this the assertion worth making.
  check('J3 the flow commits Skip, not the Connect that answered late',
    getSettings().onboarded === 'test' && getSettings().useMock === true
      && stored().onboarded === 'test' && stored().useMock === true,
    `in memory ${getSettings().onboarded}/${getSettings().useMock}, `
    + `stored ${JSON.stringify(stored().onboarded)}/${stored().useMock}`);

  check('J4 the late answer did not mount the live app',
    registered('nav-home') && !padDialog() && !setupDialog(),
    `nav-home ${registered('nav-home')}, pad ${!!padDialog()}`);

  // ── K: StrictMode's double mount must not disarm the screen ─
  // The app runs inside <StrictMode>, which mounts, tears the effect down and
  // mounts it again *against the same refs*. A cleanup-only latch is false
  // from that moment on, and every Test/Connect silently returns null — a
  // dev-only failure, because a production build does not double-run effects.
  // Mounting this small tree under StrictMode is the only way to pin it.
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
