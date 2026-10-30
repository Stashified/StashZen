#!/usr/bin/env node
/**
 * test-skim.mjs: the accelerating skim ladder.
 *
 *   node scripts/test-skim.mjs
 *
 * `nextSkimRung` decides how far a press jumps. It is pure so the timing can
 * be checked without a browser; the hook only feeds it refs.
 */

import { nextSkimRung, skimStepFor } from '../src/components/player/useSkim.js';
import {
  SKIM_STEPS, SKIM_ACCEL_RESET_MS, SKIM_RUNG_HOLD_MS,
} from '../src/components/player/constants.js';

let failed = 0;
let passed = 0;

function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
  }
}

// A press 100 ms after the previous one: inside the reset window, so the
// dwell is the only thing deciding whether the rung climbs.
const press = ({ rung, since, direction = 1, lastDirection = 1, now }) => nextSkimRung({
  rung, since, direction, lastDirection, lastAt: now - 100, now,
});

check('the ladder matches YouTube', SKIM_STEPS, [5, 10, 30, 60]);

// The upper rungs scale with duration; a tap never does.
const ladderFor = (duration) => [0, 1, 2, 3].map((rung) => skimStepFor(rung, duration));

check('a 30 min scene keeps the base ladder', ladderFor(1800), [5, 10, 30, 60]);
check('shorter scenes are no coarser', ladderFor(600), [5, 10, 30, 60]);
check('a one-hour scene doubles the upper rungs', ladderFor(3600), [5, 20, 60, 120]);
check('a two-hour scene quadruples them', ladderFor(7200), [5, 40, 120, 240]);
check('the scale is capped on very long files', ladderFor(5 * 3600), [5, 40, 120, 240]);
check('an unknown duration keeps the base ladder', ladderFor(NaN), [5, 10, 30, 60]);
check('a zero duration keeps the base ladder', ladderFor(0), [5, 10, 30, 60]);

check('the first press is the first rung', nextSkimRung({
  rung: 0, since: 0, direction: 1, lastDirection: 0, lastAt: 0, now: 10000,
}), { rung: 0, since: 10000 });

check('a repeat inside the dwell stays on rung 0', press({
  rung: 0, since: 10000, now: 10000 + SKIM_RUNG_HOLD_MS - 1,
}).rung, 0);

check('the rung climbs once the dwell has passed', press({
  rung: 0, since: 10000, now: 10000 + SKIM_RUNG_HOLD_MS,
}).rung, 1);

check('the climb restarts the dwell', press({
  rung: 0, since: 10000, now: 10000 + SKIM_RUNG_HOLD_MS,
}).since, 10000 + SKIM_RUNG_HOLD_MS);

check('a second climb needs another full dwell', press({
  rung: 1, since: 10000 + SKIM_RUNG_HOLD_MS,
  now: 10000 + SKIM_RUNG_HOLD_MS * 2 - 1,
}).rung, 1);

check('and it lands on rung 2', press({
  rung: 1, since: 10000 + SKIM_RUNG_HOLD_MS,
  now: 10000 + SKIM_RUNG_HOLD_MS * 2,
}).rung, 2);

check('the last rung is the cap', press({
  rung: 3, since: 10000, now: 10000 + SKIM_RUNG_HOLD_MS * 4,
}).rung, 3);

check('a capped rung keeps its dwell start', press({
  rung: 3, since: 10000, now: 10000 + SKIM_RUNG_HOLD_MS * 4,
}).since, 10000);

check('backward accelerates on its own', press({
  rung: 0, since: 10000, direction: -1, lastDirection: -1,
  now: 10000 + SKIM_RUNG_HOLD_MS,
}).rung, 1);

check('a direction change starts over', press({
  rung: 3, since: 0, direction: -1, lastDirection: 1,
  now: 10000 + SKIM_RUNG_HOLD_MS,
}), { rung: 0, since: 10000 + SKIM_RUNG_HOLD_MS });

check('a pause starts over', nextSkimRung({
  rung: 3, since: 0, direction: 1, lastDirection: 1,
  lastAt: 10000, now: 10000 + SKIM_ACCEL_RESET_MS + 1,
}).rung, 0);

// Holding an arrow sends keydown repeats, which arrive here as presses. The
// dwell is what keeps the rungs readable under a fast repeat rate.
{
  const step = 33;
  let state = nextSkimRung({
    rung: 0, since: 0, direction: 1, lastDirection: 0, lastAt: 0, now: 0,
  });
  let lastAt = 0;
  const rungAt = (ms) => {
    for (let t = lastAt + step; t <= ms; t += step) {
      state = nextSkimRung({
        ...state, direction: 1, lastDirection: 1, lastAt: t - step, now: t,
      });
      lastAt = t;
    }
    return state.rung;
  };

  check('a 0.9 s hold stays on the base step', rungAt(900), 0);
  check('a 1.1 s hold has climbed one rung', rungAt(1100), 1);
  check('a 2.1 s hold has climbed two', rungAt(2100), 2);
  check('a 3.1 s hold reaches the cap', rungAt(3100), 3);
  check('and it stays there', rungAt(6000), 3);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
