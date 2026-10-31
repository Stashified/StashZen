#!/usr/bin/env node
/**
 * test-lock-timing.mjs: how AppLock measures an absence
 *
 *   node scripts/test-lock-timing.mjs
 *
 * The PIN has to survive a TV suspend. `performance.now()` can stop while the
 * system sleeps, `Date.now()` does not but can be set, and a backwards wall
 * clock must fail closed (lock) rather than open.
 */

import { absenceMs } from '../src/utils/lockTiming.js';

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

const hidden = (mono, wall) => ({ mono, wall });

check('a short hide uses the monotonic difference',
  absenceMs(hidden(1000, 5000), hidden(1300, 5300)) === 300,
  String(absenceMs(hidden(1000, 5000), hidden(1300, 5300))));

check('time the monotonic clock missed in suspend comes from the wall clock',
  absenceMs(hidden(1000, 5000), hidden(1100, 3605000)) === 3600000,
  String(absenceMs(hidden(1000, 5000), hidden(1100, 3605000))));

check('the larger measurement wins when both clocks advanced',
  absenceMs(hidden(1000, 5000), hidden(9000, 6000)) === 8000,
  String(absenceMs(hidden(1000, 5000), hidden(9000, 6000))));

check('a backwards wall clock is an unknown absence, not a short one',
  absenceMs(hidden(1000, 5000), hidden(1100, 4000)) === Infinity,
  String(absenceMs(hidden(1000, 5000), hidden(1100, 4000))));

check('no time passed',
  absenceMs(hidden(1000, 5000), hidden(1000, 5000)) === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
