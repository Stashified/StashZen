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

// ── producer and validator agree ────────────────────────
// A real blob must pass the shape check its own module applies on load.
{
  check('a PIN can be set for the round trip', lock.setPin('2468'));
  const reloaded = await import('../src/utils/appLock.js?case=roundtrip');
  check('a blob written here counts as locked after reload', reloaded.isLockSet());
  check('and the same PIN verifies after reload', reloaded.verifyPin('2468'));
  check('and a wrong PIN does not', !reloaded.verifyPin('1357'));
  // The validator treats a missing `v` as v1 (see the legacy case), so only
  // this pins the writer's version field.
  check('setPin writes v1', JSON.parse(store.get(lock.LS_KEY))?.v === 1,
    store.get(lock.LS_KEY));
  lock.clearPin();
}

// ── corrupt / future blobs fail open ────────────────────
// `state` is loaded at import time, so each case re-imports the module with a
// unique query to get a fresh copy reading the blob just written.
async function freshLockWith(blob, tag) {
  store.set(lock.LS_KEY, JSON.stringify(blob));
  return import(`../src/utils/appLock.js?case=${tag}`);
}

{
  const salt = 'a'.repeat(32);
  const hash = 'b'.repeat(64);
  const ok = await freshLockWith({ v: 1, salt, hash }, 'valid');
  check('a shape-valid blob counts as locked', ok.isLockSet());
}
{
  const bad = await freshLockWith(
    { v: 1, salt: 'a'.repeat(32), hash: 'b'.repeat(63) }, 'badhash');
  check('a truncated hash fails open', !bad.isLockSet());
}
{
  const bad = await freshLockWith(
    { v: 1, salt: 'z'.repeat(32), hash: 'b'.repeat(64) }, 'badsalt');
  check('a non-hex salt fails open', !bad.isLockSet());
}
{
  const bad = await freshLockWith(
    { v: 2, salt: 'a'.repeat(32), hash: 'b'.repeat(64) }, 'badver');
  check('an unknown version fails open', !bad.isLockSet());
}
{
  const legacy = await freshLockWith(
    { salt: 'a'.repeat(32), hash: 'b'.repeat(64) }, 'legacy');
  check('a blob without v is still v1', legacy.isLockSet());
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
