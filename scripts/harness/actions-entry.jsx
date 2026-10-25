/**
 * Headless driver for the two TV action surfaces — SettingsPanel and
 * ExitPrompt.
 *
 * The observable contract of the button: which element holds focus, what a
 * press does, and what the DOM says afterwards. A button that silently stopped
 * responding fails; a refactor that swapped the component for a `<div>` would
 * pass "the label is on screen" and fail everything else.
 *
 * Chosen with `?view=settings` (default) or `?view=exit`.
 */

import { createRoot } from 'react-dom/client';
// The real theme: without it `var(--accent-fill)` is invalid at computed-value
// time and resolves to transparent, so A5 would compare two invisible
// backgrounds and fail against correct code.
import '../../src/index.css';
import SettingsPanel from '../../src/components/SettingsPanel.jsx';
import ExitPrompt from '../../src/components/ExitPrompt.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { setSettings, getSettings } from '../../src/utils/settings.js';
import { isLockSet, setPin, clearPin } from '../../src/utils/appLock.js';

const PORT = window.__PORT__;
const VIEW = new URLSearchParams(location.search).get('view') || 'settings';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Poll for a DOM condition a state update produces, rather than guessing. */
async function waitFor(pred, ms = 2000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

// ── Input ───────────────────────────────────────────────────
// Dispatched on whatever holds focus, as a remote would. Every button here
// fires on keydown; none opts into onLongPress, which moves the short action
// to keyup.
const active = () => document.activeElement || document.body;
function press(key, keyCode) {
  active().dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}
const enter = async (el) => {
  el?.focus();
  await sleep(60);
  press('Enter', 13);
  await sleep(180);
};

// ── Locating the buttons ────────────────────────────────────
// By role and label, not class: CSS-module names are hashed, and part of the
// contract is that the shared component still produces a real <button>.
const buttons = () => [...document.querySelectorAll('[role="dialog"] button')];
const byLabel = (label) => buttons().find(b => b.textContent.trim() === label);
const labels = () => buttons().map(b => b.textContent.trim());
const focusedLabel = () => document.activeElement?.textContent?.trim() ?? null;

// ── The PIN pad ─────────────────────────────────────────────
// PinPad namespaces ids with useId(), so digits are addressed by their label.
// Its dialog is the second one; the panel is already labelled "Settings".
const pad = () => [...document.querySelectorAll('[role="dialog"]')]
  .find(d => /PIN$/.test(d.getAttribute('aria-label') || '')) || null;

const padButton = (label) => {
  const d = pad();
  if (!d) return null;
  return [...d.querySelectorAll('button')]
    .find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === label) || null;
};

const enterPin = (pin) => {
  for (const digit of pin) padButton(digit)?.click();
};

/** Any live region whose text matches, so an unrelated status line cannot pass. */
const statusSays = (re) => [...document.querySelectorAll('[role="status"]')]
  .some(el => re.test(el.textContent || ''));

/** Patch the fake server's behaviour. */
async function setMode(patch) {
  await fetch('/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

// ── SettingsPanel ───────────────────────────────────────────
async function runSettings() {
  await sleep(700);

  // ── A1  Every action is on screen, and is a button ───────
  // The label list is the point: a shared component that dropped one — or
  // rendered a non-focusable node — fails here. The toggle's default is pinned
  // by preview-entry's P0; this checks only that the control exists.
  const want = [
    'Test connection', 'Run setup again', 'On',
    'Show library stats', 'Check server status',
    'Set PIN', 'Clear saved', 'Cancel', 'Save',
  ];
  check('A1 every action is rendered as a button',
    want.every(w => !!byLabel(w)), `found: ${labels().join(' | ')}`);

  // ── A2  Enter on the toggle flips aria-pressed ───────────
  // The one action with a self-contained synchronous observable: `press` is
  // not passed by every caller, but those that pass it expect it on the DOM.
  const toggle = byLabel('Off') || byLabel('On');
  const before = toggle?.getAttribute('aria-pressed');
  await enter(toggle);
  const after = (byLabel('Off') || byLabel('On'))?.getAttribute('aria-pressed');
  // A flip, not a direction: the default belongs to preview-entry's P0, and
  // asserting "off → on" would fail on a default change for the wrong reason.
  check('A2 pressing the toggle flips aria-pressed',
    before !== after && ['true', 'false'].includes(before)
      && ['true', 'false'].includes(after),
    `before=${before} after=${after}`);

  // ── A3  Enter on Test connection reaches the server ──────
  // The request left and the result rendered. The fake answers `version`,
  // which testStashConnection asks for; a button wired to nothing stays empty.
  await enter(byLabel('Test connection'));
  await sleep(900);
  const resultText = document.querySelector('[role="dialog"]')?.textContent || '';
  check('A3 Test connection reported a result',
    /✓|✗/.test(resultText),
    `result row: ${(resultText.match(/[✓✗][^✓✗]{0,40}/) || ['<none>'])[0]}`);

  // ── A4  Enter on Cancel asks, and only an answer closes ──
  // A2 left the draft dirty, so this is the unsaved path: Cancel raises the
  // question instead of closing, and only an answer leaves. The store is read
  // either side, so a handler wired to the wrong action saves the refused
  // draft.
  const urlBefore = getSettings().stashUrl;
  await enter(byLabel('Cancel'));
  const asked = await waitFor(() =>
    !!byLabel('Keep editing') && !!byLabel('Discard') && !!byLabel('Save & close'), 2000);
  check('A4 Cancel with an unsaved draft asks first',
    asked && window.__closed !== true,
    `prompt=${asked} onClose called: ${window.__closed === true}`);
  await enter(byLabel('Discard'));
  await sleep(200);
  check('A4 Discard asked the panel to close', window.__closed === true,
    `onClose called: ${window.__closed === true}`);
  // The detail is port-free on the passing path: the port is random, so a
  // run-dependent detail puts a spurious line in every differential diff. The
  // informative form is kept for the failure.
  check('A4 Cancel did not commit the draft to the store',
    getSettings().stashUrl === urlBefore,
    getSettings().stashUrl === urlBefore ? 'store unchanged' : `${urlBefore} → ${getSettings().stashUrl}`);

  // ── A5  The primary button is marked as such ─────────────
  // `primary` is the one prop the shared component must pass through, and it
  // is otherwise invisible. Asserted on computed background, not class: a
  // hashed name on the wrong element would pass, and the user must see which
  // action is primary.
  const saveBg = getComputedStyle(byLabel('Save')).backgroundColor;
  const cancelBg = getComputedStyle(byLabel('Cancel')).backgroundColor;
  check('A5 the primary action looks different from the secondary one',
    saveBg !== cancelBg, `Save ${saveBg} vs Cancel ${cancelBg}`);

  // ── C: the live connection block belongs to Live mode ───
  // Test mode used to dim these fields and leave them in the focus order — the
  // D-pad could select the endpoint while the hint said otherwise. They are
  // now unmounted, so the result line cannot outlive the mode.
  check('C0 the live fields are present in Live mode',
    !!registry.get('settings-url') && !!registry.get('settings-key')
      && !!registry.get('settings-test'),
    `url ${!!registry.get('settings-url')}, key ${!!registry.get('settings-key')}, `
    + `test ${!!registry.get('settings-test')}`);

  await enter(byLabel('Test'));
  await sleep(250);
  check('C1 Test mode takes the live fields out of the focus order',
    !registry.get('settings-url') && !registry.get('settings-key')
      && !registry.get('settings-test'),
    `url ${!!registry.get('settings-url')}, key ${!!registry.get('settings-key')}, `
    + `test ${!!registry.get('settings-test')}`);

  await enter(byLabel('Live'));
  await sleep(250);
  check('C2 flipping back to Live restores them',
    !!registry.get('settings-url') && !!registry.get('settings-test'),
    `url ${!!registry.get('settings-url')}, test ${!!registry.get('settings-test')}`);
  // A3's ✓ belongs to Live mode and must not come back after a round trip
  // through Test: the fields it was measured against were not on screen.
  check('C2 ...without resurrecting the previous result line',
    !(document.querySelector('[role="dialog"]')?.textContent || '').includes('Connected — Stash'),
    `dialog contains Connected: ${(document.querySelector('[role="dialog"]')?.textContent || '').includes('Connected — Stash')}`);

  // ── C3: an answer asked for in Live cannot land in Test ─
  // The panel stays mounted while the test is in flight: the mode switch must
  // invalidate the question, not just hide its answer.
  await setMode({ connection: 'slow' });
  await enter(byLabel('Test connection'));
  await sleep(150);              // the request is in flight
  await enter(byLabel('Test'));  // ...and the mode is changed under it
  await sleep(2000);             // the held answer lands here
  await enter(byLabel('Live'));
  await sleep(300);
  check('C3 a late answer does not paint a result for a mode that replaced it',
    !(document.querySelector('[role="dialog"]')?.textContent || '').includes('Connected — Stash'),
    `dialog contains Connected: ${(document.querySelector('[role="dialog"]')?.textContent || '').includes('Connected — Stash')}`);
  await setMode({ connection: 'ok' });

  // ── D: the scan notice points at where the job appears ──
  await enter(byLabel('Scan library'));
  await sleep(700);
  check('D1 a started scan says the progress is below the notice',
    statusSays(/progress appears below/),
    `status lines: ${[...document.querySelectorAll('[role="status"]')]
      .map(el => JSON.stringify(el.textContent)).join(', ')}`);

  // ── P: a PIN set in this session is removable in it ─────
  // The Remove button exists only while a PIN does, and this panel mounted
  // without one. `useFocusable` registers in an effect keyed on element
  // identity, so a hook above it missed the first run and never re-ran; the
  // check is the registry entry, which is what the D-pad navigates by.
  clearPin();
  await sleep(150);

  await enter(byLabel('Set PIN'));
  await sleep(400);
  check('P0 Set PIN opens the keypad', !!pad(),
    `pad ${pad()?.getAttribute('aria-label') ?? '<none>'}`);

  enterPin('1234');
  await sleep(300);
  check('P1 the first entry moves on to the confirm phase',
    /Confirm PIN/.test(pad()?.getAttribute('aria-label') || ''),
    `pad ${pad()?.getAttribute('aria-label') ?? '<none>'}`);

  enterPin('1234');
  await sleep(500);
  check('P2 the PIN is set and the keypad closes',
    isLockSet() && !pad(),
    `isLockSet ${isLockSet()}, pad ${!!pad()}`);

  const removeEntry = registry.get('settings-lock-remove');
  check('P3 Remove PIN is a live focus stop on the mount that adds it',
    !!removeEntry && document.contains(removeEntry.el),
    `registry entry ${!!removeEntry}, connected ${!!removeEntry && document.contains(removeEntry.el)}`);

  await enter(removeEntry?.el);
  check('P4 the first press only arms the confirmation',
    isLockSet() && /Press again to confirm/.test(removeEntry?.el?.textContent || ''),
    `isLockSet ${isLockSet()}, label ${JSON.stringify(removeEntry?.el?.textContent)}`);

  await enter(removeEntry?.el);
  await sleep(200);
  check('P5 the second press removes the PIN', !isLockSet(),
    `isLockSet ${isLockSet()}`);
  check('P6 focus moved off the button that unmounted',
    document.activeElement === registry.get('settings-lock-primary')?.el,
    `focused "${focusedLabel() ?? '<none>'}"`);

  // ── Q: a storage failure is reported, not papered over ──
  setPin('4321');
  await sleep(250);
  const removeAgain = registry.get('settings-lock-remove')?.el;
  check('Q0 the Remove button registers again on a fresh mount',
    !!removeAgain && document.contains(removeAgain),
    `entry ${!!removeAgain}`);

  // clearPin() writes by removing the key; make that one remove fail.
  const realRemoveItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (name) {
    if (name === 'tvapp.lock.v1') throw new Error('simulated storage failure');
    return realRemoveItem.call(this, name);
  };
  try {
    await enter(removeAgain);
    await enter(removeAgain);
    await sleep(150);
    check('Q1 a failed removal says why',
      statusSays(/Could not remove the PIN/),
      `status lines: ${[...document.querySelectorAll('[role="status"]')]
        .map(el => JSON.stringify(el.textContent)).join(', ')}`);
    check('Q2 ...and leaves the lock in place', isLockSet(),
      `isLockSet ${isLockSet()}`);
  } finally {
    Storage.prototype.removeItem = realRemoveItem;
  }
  clearPin();
}

// ── ExitPrompt ──────────────────────────────────────────────
async function runExit() {
  await sleep(700);

  check('E1 both actions are rendered as buttons',
    labels().join('|') === 'Cancel|Exit', `found: ${labels().join(' | ')}`);

  // It autofocuses because Back opens it: landing on Exit would let a double
  // Back quit the app. Asserted on the focused element, not the attribute.
  check('E1 focus starts on the safe action', focusedLabel() === 'Cancel',
    `focused: ${focusedLabel() ?? '<none>'}`);

  await enter(byLabel('Cancel'));
  await sleep(200);
  check('E2 Cancel asked the prompt to close', window.__cancelled === true,
    `onCancel called: ${window.__cancelled === true}`);
}

const root = document.getElementById('root');
root.style.cssText = 'height:100vh;display:flex;flex-direction:column;overflow:hidden;';
document.body.style.margin = '0';

// The panel seeds its draft from the connection settings, so they must be in
// the store before it mounts; otherwise the fields render defaults and A4
// compares two identical empty strings.
setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness', onboarded: 'live' });

const onClose = () => { window.__closed = true; };
const onCancel = () => { window.__cancelled = true; };

(async () => {
  createRoot(root).render(
    VIEW === 'exit' ? <ExitPrompt onCancel={onCancel} /> : <SettingsPanel onClose={onClose} />,
  );

  try {
    await (VIEW === 'exit' ? runExit() : runSettings());
    check('view under test', true, VIEW);
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
