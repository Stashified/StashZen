/**
 * Headless driver for the app-lock retry backoff.
 *
 * The lock itself is covered elsewhere (firstrun/actions set, change and
 * remove a PIN). This driver is about the thing a remote makes possible:
 * unlimited guesses. A 4-digit PIN is 10⁴ combinations, which is minutes of
 * D-pad work if each press is free.
 *
 * Two layers are asserted:
 *   1. `attemptPin` — the counter, the escalating delay, and the fact that a
 *      correct PIN submitted during the delay is not even checked.
 *   2. LockScreen — the message a user actually sees for a wrong PIN, for a
 *      blocked attempt, and that unlock happens once the delay expires.
 *
 * The 30 s step is not exercised (three 5 s waits to reach it would dominate
 * the sweep); the 1 s and 5 s steps prove the ladder is wired.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
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
  // `retryAfterMs` is the delay the *next* attempt faces, not time this one
  // waited — so the third miss is still checked, and then arms the wait.
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
    /^Incorrect PIN — wait [12]s before trying again$/.test(errorText()),
    JSON.stringify(errorText()));

  await typePin('1234');
  await waitFor(() => errorText().includes('Too many attempts'), 1500);
  check('P7 a correct PIN during the delay is refused with the remaining time',
    /^Too many attempts — try again in [12]s$/.test(errorText()) && unlockCount === 0,
    `${JSON.stringify(errorText())} unlocks=${unlockCount}`);

  await sleep(1100);
  await typePin('1234');
  await waitFor(() => unlockCount === 1, 1500);
  check('P8 after the delay the same PIN unlocks', unlockCount === 1, `unlocks=${unlockCount}`);
  root.unmount();
  host.remove();

  // ── 3. The ladder reaches 5 s ────────────────────────────
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
