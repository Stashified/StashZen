/**
 * Headless driver for the app-lock retry backoff. A 4-digit PIN is 10⁴
 * combinations, minutes of D-pad work if each press is free.
 *
 * Asserts three layers: `attemptPin` (the counter, escalating delay, and that
 * a correct PIN during the delay is not even checked); LockScreen's messages
 * for a wrong and a blocked attempt, and unlock once the delay expires; and
 * LockScreen's Back, which opens the exit confirmation rather than dismissing
 * the lock, with cancel restoring focus.
 *
 * The 30 s step is skipped (three 5 s waits would dominate the sweep); 1 s and
 * 5 s prove the ladder is wired.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import AppLock from '../../src/components/AppLock.jsx';
import LockScreen from '../../src/components/LockScreen.jsx';
import {
  setPin, clearPin, attemptPin, pinRetryDelayMs,
} from '../../src/utils/appLock.js';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, ms = 3000, step = 20) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

async function typePin(pin) {
  for (const d of String(pin)) {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: d, keyCode: 48 + Number(d), bubbles: true, cancelable: true,
    }));
    await sleep(20);
  }
  await sleep(60);
}

function errorText() {
  return (document.querySelector('[role="status"]')?.textContent || '').trim();
}

async function run() {
  // ── 1. The limiter itself ────────────────────────────────
  check('P1 setPin succeeds', setPin('1234'), `lockSet=${pinRetryDelayMs() === 0}`);

  const a1 = attemptPin('0000');
  const a2 = attemptPin('0001');
  const a3 = attemptPin('0002');
  // `retryAfterMs` is the delay the next attempt faces, so the third miss is
  // still checked and then arms the wait.
  check('P2 the first three misses are each checked immediately',
    !a1.ok && !a1.blocked && !a2.ok && !a2.blocked && !a3.ok && !a3.blocked,
    `blocked=${[a1, a2, a3].map(r => r.blocked).join(',')}`);
  check('P2 delays arm after the first and second miss are zero',
    a1.retryAfterMs === 0 && a2.retryAfterMs === 0,
    `delays=${a1.retryAfterMs},${a2.retryAfterMs}`);
  check('P2 the third miss arms a 1 s delay',
    a3.retryAfterMs === 1000 && a3.failures === 3,
    `retry=${a3.retryAfterMs} failures=${a3.failures}`);

  // The important one: a correct PIN during the cooldown must not unlock.
  const blocked = attemptPin('1234');
  check('P3 a correct PIN during the cooldown is not checked',
    blocked.ok === false && blocked.blocked === true && blocked.failures === undefined,
    JSON.stringify(blocked));
  check('P3 the cooldown is observable', pinRetryDelayMs() > 0, `${pinRetryDelayMs()}ms`);

  await sleep(1100);
  const unlocked = attemptPin('1234');
  check('P4 after the delay a correct PIN unlocks', unlocked.ok === true, JSON.stringify(unlocked));
  check('P4 success resets the counter',
    attemptPin('9999').retryAfterMs === 0 && pinRetryDelayMs() === 0);

  // ── 2. LockScreen's messages ─────────────────────────────
  setPin('1234');   // resets the counter
  let unlockCount = 0;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<LockScreen onUnlock={() => { unlockCount += 1; }} />);
  await waitFor(() => !!document.querySelector('[role="dialog"]'));

  await typePin('0000');
  await waitFor(() => errorText().length > 0, 1500);
  check('P5 a wrong PIN shows "Incorrect PIN"',
    errorText() === 'Incorrect PIN', JSON.stringify(errorText()));

  await typePin('0001');
  await typePin('0002');
  await waitFor(() => errorText().includes('wait'), 1500);
  check('P6 the third wrong PIN names the delay',
    /^Incorrect PIN, wait [12]s before trying again$/.test(errorText()),
    JSON.stringify(errorText()));

  await typePin('1234');
  await waitFor(() => errorText().includes('Too many attempts'), 1500);
  check('P7 a correct PIN during the delay is refused with the remaining time',
    /^Too many attempts, try again in [12]s$/.test(errorText()) && unlockCount === 0,
    `${JSON.stringify(errorText())} unlocks=${unlockCount}`);

  await sleep(1100);
  await typePin('1234');
  await waitFor(() => unlockCount === 1, 1500);
  check('P8 after the delay the same PIN unlocks', unlockCount === 1, `unlocks=${unlockCount}`);
  root.unmount();
  host.remove();

  // ── 3. Back on the lock screen ───────────────────────────
  // Back must not dismiss the lock, but must answer: it opens the exit
  // confirmation with the keypad unmounted underneath, so digits cannot reach
  // it and focus lands back on "1" on close.
  setPin('1234');   // resets the failure counter from section 2
  let backUnlockCount = 0;
  const backHost = document.createElement('div');
  document.body.appendChild(backHost);
  const backRoot = createRoot(backHost);
  backRoot.render(<LockScreen onUnlock={() => { backUnlockCount += 1; }} />);

  const exitDialog = () => document.querySelector('[role="dialog"][aria-label="Exit confirmation"]');
  const padDialog = () => document.querySelector('[role="dialog"][aria-label="Enter PIN"]');
  const pressBack = async (key = 'Escape', keyCode = 27) => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key, keyCode, bubbles: true, cancelable: true,
    }));
    await sleep(100);
  };

  await waitFor(() => !!padDialog());
  await pressBack();
  check('B1 Back on the lock screen asks before closing the app',
    !!exitDialog() && !padDialog() && backUnlockCount === 0,
    `exit=${!!exitDialog()} pad=${!!padDialog()}`);

  // With the pad still mounted this would unlock (PIN 1234), not merely feed
  // the dialog's layer.
  await typePin('1234');
  check('B2 digits do not reach the keypad behind the prompt',
    backUnlockCount === 0 && !!exitDialog(),
    `unlocks=${backUnlockCount} exit=${!!exitDialog()}`);

  await pressBack();
  check('B3 Back again cancels and returns to the keypad',
    !exitDialog() && !!padDialog() && backUnlockCount === 0,
    `exit=${!!exitDialog()} pad=${!!padDialog()}`);
  check('B4 the keypad takes focus back on "1"',
    document.activeElement?.getAttribute('aria-label') === '1',
    `focus=${document.activeElement?.getAttribute('aria-label')}`);

  // Tizen's hardware Back (10009); Escape is its desktop spelling.
  await pressBack('', 10009);
  check('B5 Tizen Back also reaches the exit prompt', !!exitDialog());
  backRoot.unmount();
  backHost.remove();

  // ── 4. The ladder reaches 5 s ────────────────────────────
  setPin('1234');
  attemptPin('0000');
  attemptPin('0001');
  attemptPin('0002');
  await sleep(1050);
  const fourth = attemptPin('0003');
  await sleep(1050);
  const fifth = attemptPin('0004');
  check('P9 a fifth consecutive miss costs 5 s',
    fourth.retryAfterMs === 1000 && fifth.retryAfterMs === 5000,
    `fourth=${fourth.retryAfterMs} fifth=${fifth.retryAfterMs}`);

  // ── 5. A resume must not paint the app before the keypad ─
  // A resumed Tizen app repaints its last frame before a state update from
  // the visibility handler can commit, so the fix has two halves: a raw-DOM
  // cover applied while hidden (the restored frame is the themed background),
  // and a synchronous keypad commit on return (the uncovered frame is already
  // it). Mounted into #root because the cover rule targets that container.
  {
    setPin('1234');   // also resets the failure counter from section 3
    const host = document.getElementById('root');
    const root = createRoot(host);
    root.render(
      <AppLock>
        <div id="app-lock-child">library</div>
      </AppLock>,
    );

    await waitFor(() => !!document.querySelector('[role="dialog"]'));
    check('P10 a cold start with a PIN set mounts the keypad, no app content',
      !!document.querySelector('[role="dialog"]')
        && !document.getElementById('app-lock-child'),
      `pad=${!!document.querySelector('[role="dialog"]')}`
      + ` child=${!!document.getElementById('app-lock-child')}`);

    await typePin('1234');
    await waitFor(() => !!document.getElementById('app-lock-child'));
    check('P11 the correct PIN reveals the app',
      !!document.getElementById('app-lock-child'),
      `child=${!!document.getElementById('app-lock-child')}`
      + ` err=${JSON.stringify(errorText())}`);

    // Simulate the Tizen lifecycle: visibilityState is read-only, so it is
    // overridden and restored.
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: () => visibility,
    });
    const hide = () => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const show = () => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const covered = () => document.documentElement.hasAttribute('data-lock-cover')
      && getComputedStyle(document.getElementById('app-lock-child')).visibility === 'hidden';

    hide();
    // Synchronously, before any frame: this is what the compositor restores.
    check('P12 hiding with a PIN set covers the app immediately', covered(),
      `attr=${document.documentElement.hasAttribute('data-lock-cover')}`);

    await sleep(300);
    show();
    check('P13 a short hide (the TV menu) returns to the app uncovered',
      !!document.getElementById('app-lock-child')
        && !document.querySelector('[role="dialog"]')
        && !document.documentElement.hasAttribute('data-lock-cover'),
      `child=${!!document.getElementById('app-lock-child')}`
      + ` pad=${!!document.querySelector('[role="dialog"]')}`
      + ` attr=${document.documentElement.hasAttribute('data-lock-cover')}`);

    hide();
    await sleep(1700);
    show();
    check('P14 a long hide returns to the keypad, not the app',
      !!document.querySelector('[role="dialog"]')
        && !document.getElementById('app-lock-child'),
      `pad=${!!document.querySelector('[role="dialog"]')}`
      + ` child=${!!document.getElementById('app-lock-child')}`);
    // One frame behind the commit and the uncovered paint would be the
    // library, the defect itself.
    check('P15 the cover is gone in the same task that commits the keypad',
      !document.documentElement.hasAttribute('data-lock-cover'),
      `attr=${document.documentElement.getAttribute('data-lock-cover')}`);

    try { delete document.visibilityState; } catch (e) { /* keep the override */ }
    root.unmount();
  }

  clearPin();
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

run().then(finish).catch(async (e) => {
  check('P10 the driver itself threw', false,
    String(e && e.stack ? e.stack.split('\n')[0] : e));
  await finish();
});
