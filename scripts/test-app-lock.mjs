#!/usr/bin/env node
/**
 * test-app-lock.mjs: PIN hashing and the wrong-PIN backoff table
 *
 *   node scripts/test-app-lock.mjs
 *
 * Date.now is frozen so the test can wait out each block without sleeping.
 * The table is indexed by consecutive failures; an off-by-one there is
 * invisible until someone counts the free guesses.
 */

const store = new Map();
globalThis.localStorage = {
  getItem(k) { return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { store.set(k, String(v)); },
  removeItem(k) { store.delete(k); },
};

let now = 1_000_000;
Date.now = () => now;

const lock = await import('../src/utils/appLock.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── set / verify / clear ────────────────────────────────
check('no PIN means unlocked', !lock.isLockSet());
check('a 4-digit PIN is accepted', lock.setPin('1234'));
check('the lock is now set', lock.isLockSet());
check('the stored PIN verifies', lock.verifyPin('1234'));
check('another PIN does not', !lock.verifyPin('0000'));
check('a malformed PIN cannot be set', !lock.setPin('12a4'));

// ── backoff table ───────────────────────────────────────
// First three misses free, then 1s, 5s and 30s.
const EXPECTED = [0, 0, 0, 1000, 1000, 5000, 5000, 5000, 30000, 30000];
for (let i = 0; i < EXPECTED.length; i++) {
  now += lock.pinRetryDelayMs();          // wait out the previous block
  const result = lock.attemptPin('0000');
  check(`miss ${i + 1}: ${EXPECTED[i]} ms`,
    result.retryAfterMs === EXPECTED[i] && result.blocked === false,
    `got ${result.retryAfterMs} blocked=${result.blocked}`);
}

// A blocked attempt must not spend a guess or extend the counter.
{
  const wait = lock.pinRetryDelayMs();
  const blocked = lock.attemptPin('0000');
  check('a blocked attempt is refused without counting',
    wait > 0 && blocked.blocked === true && blocked.failures === undefined,
    `wait=${wait} ${JSON.stringify(blocked)}`);
}

// A success resets the counter: the next wrong PIN is free again.
{
  now += lock.pinRetryDelayMs();
  check('the right PIN unlocks', lock.attemptPin('1234').ok === true);
  const next = lock.attemptPin('0000');
  check('the counter resets after a success', next.retryAfterMs === 0, `got ${next.retryAfterMs}`);
}

check('clearing the PIN unlocks', lock.clearPin() && !lock.isLockSet());

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
