#!/usr/bin/env node
/**
 * test-restore-pending.mjs: the restore hold's tokens and bound
 *
 *   node scripts/test-restore-pending.mjs
 *
 * The hold is bounded so a restore that cannot land (a deleted card) still
 * leaves focus and working arrows. Expiry must drop only the expired entry: a
 * late `endRestore` from an expired restore must not release a newer hold.
 */

import {
  beginRestore, claimArrowSwallow, endRestore, isRestorePending,
} from '../src/utils/restorePending.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

// The module reads the wall clock at call time, so this is the whole clock.
let now = 1_000_000;
Date.now = () => now;
const advance = (ms) => { now += ms; };

check('nothing is pending before a restore', isRestorePending() === false);

const a = beginRestore();
check('a restore raises the hold', isRestorePending() === true);

const b = beginRestore();
endRestore(a);
check('ending the older restore leaves the newer hold up', isRestorePending() === true);

endRestore(b);
check('ending the last restore drops the hold', isRestorePending() === false);

beginRestore();
advance(3999);
check('the hold is up just under the bound', isRestorePending() === true);
advance(1);
check('the hold gives up at the bound', isRestorePending() === false);
check('querying an expired hold again is stable', isRestorePending() === false);

const late = beginRestore();
advance(4100);
check('an expired restore no longer holds', isRestorePending() === false);
const fresh = beginRestore();
endRestore(late);
check('a late end does not release a fresh hold', isRestorePending() === true);
endRestore(fresh);
check('the fresh hold ends on its own token', isRestorePending() === false);

const press = beginRestore();
check('the first arrow press is swallowed', claimArrowSwallow() === true);
check('a second fresh press is not', claimArrowSwallow() === false);
endRestore(press);

const nextPress = beginRestore();
check('a new restore gets its own swallow again', claimArrowSwallow() === true);
endRestore(nextPress);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
