#!/usr/bin/env node
/**
 * test-rating-steps.mjs: the rating stepper's step rule
 *
 *   node scripts/test-rating-steps.mjs
 *
 * Stash stores rating100, and another client can leave an off-grid value
 * (75). A step must move to the neighbouring multiple of 10 from that value,
 * not from its rounded star count, or one press skips 15 points.
 */

import { nextRating, ratingLabel } from '../src/utils/format.js';

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

// ── nextRating ───────────────────────────────────────────
const cases = [
  [0, 1, 10], [0, -1, 0],
  [10, 1, 20], [10, -1, 0],
  [5, 1, 10], [5, -1, 0],
  [74, 1, 80], [74, -1, 70],
  [75, 1, 80], [75, -1, 70],
  [79, 1, 80], [79, -1, 70],
  [80, 1, 90], [80, -1, 70],
  [95, 1, 100], [95, -1, 90],
  [100, 1, 100], [100, -1, 90],
  [null, 1, 10], [null, -1, 0],
];
for (const [from, dir, want] of cases) {
  const got = nextRating(from, dir);
  check(`${String(from)} ${dir > 0 ? '+' : '-'} → ${want}`, got === want, `got ${got}`);
}

// Away from a bound a step moves exactly one star, the common case every
// press takes.
for (const v of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]) {
  check(`on-grid ${v} + is one star`, nextRating(v, 1) === Math.min(100, v + 10), `got ${nextRating(v, 1)}`);
  check(`on-grid ${v} - is one star`, nextRating(v, -1) === Math.max(0, v - 10), `got ${nextRating(v, -1)}`);
}

// ── ratingLabel agrees with the display value ────────────
check('an off-grid value keeps its decimal', ratingLabel(75) === '7.5', ratingLabel(75));
check('an on-grid value keeps its decimal', ratingLabel(80) === '8.0', ratingLabel(80));

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
