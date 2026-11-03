#!/usr/bin/env node
/**
 * test-capabilities.mjs: pure tests for the server-version gate.
 *
 * A gated request against an older server fails the whole query, so the
 * interesting cases are the ones that must stay closed: no version yet, an
 * unreadable version, and a version just below the floor.
 */

import { supportsCapability, CAPABILITY_MIN_VERSION } from '../src/utils/capabilities.js';
import { visibleSortGroups } from '../src/utils/sortGroups.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── supportsCapability ──────────────────────────────────
check('cap: the floor version is supported',
  supportsCapability('0.32.0', 'productionDate') === true);
check('cap: a newer version is supported',
  supportsCapability('0.33.1', 'productionDate') === true);
check('cap: the version below the floor is not',
  supportsCapability('0.31.1', 'productionDate') === false);
check('cap: a v prefix does not matter',
  supportsCapability('v0.32.0', 'productionDate') === true);
check('cap: a suffix does not matter',
  supportsCapability('0.32.0-harness', 'productionDate') === true);
check('cap: no version hides the feature',
  supportsCapability(null, 'productionDate') === false
  && supportsCapability(undefined, 'productionDate') === false
  && supportsCapability('', 'productionDate') === false);
// `null >= 0` is true in JS; the implementation must not let an unreadable
// version through on that coercion.
check('cap: an unreadable version hides the feature',
  supportsCapability('junk', 'productionDate') === false);
check('cap: an unknown capability is never supported',
  supportsCapability('0.32.0', 'no-such-feature') === false);

check('cap: every registered capability names a version',
  Object.values(CAPABILITY_MIN_VERSION).every(v => /^\d+\.\d+\.\d+$/.test(v)));

// ── visibleSortGroups ───────────────────────────────────
const GROUPS = [
  { group: 'General', options: [
    { value: 'name', label: 'Name' },
    { value: 'production_date', label: 'Production Date', capability: 'productionDate' },
  ] },
  { group: 'Gated', options: [
    { value: 'performer_age', label: 'Performer Age', capability: 'performerAgeSort' },
  ] },
];

eq('sorts: a newer server sees every option',
  visibleSortGroups(GROUPS, '0.32.0').map(g => g.options.map(o => o.value)),
  [['name', 'production_date'], ['performer_age']]);

eq('sorts: an older server loses the gated options',
  visibleSortGroups(GROUPS, '0.31.1').map(g => g.options.map(o => o.value)),
  [['name']]);

eq('sorts: a group with nothing left disappears',
  visibleSortGroups(GROUPS, '0.31.1').map(g => g.group), ['General']);

eq('sorts: no version hides every gated option',
  visibleSortGroups(GROUPS, null).map(g => g.options.map(o => o.value)),
  [['name']]);

eq('sorts: undefined is empty, not a throw', visibleSortGroups(undefined, '0.32.0'), []);

const snapshot = JSON.stringify(GROUPS);
visibleSortGroups(GROUPS, '0.31.1');
check('sorts: the input table is not mutated', JSON.stringify(GROUPS) === snapshot,
  JSON.stringify(GROUPS));

console.log('\n── 0.32 gates');
check('hierarchicalTagCounts arrives in 0.32',
  supportsCapability('0.32.0', 'hierarchicalTagCounts') === true);
check('hierarchicalTagCounts is absent on 0.31',
  supportsCapability('0.31.1', 'hierarchicalTagCounts') === false);
check('studioRecursiveCounts arrives in 0.32',
  supportsCapability('0.32.0', 'studioRecursiveCounts') === true);
check('studioRecursiveCounts is absent on 0.31',
  supportsCapability('0.31.1', 'studioRecursiveCounts') === false);
check('an unknown version gates both',
  !supportsCapability(null, 'hierarchicalTagCounts')
  && !supportsCapability(undefined, 'studioRecursiveCounts'));

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
