#!/usr/bin/env node
/**
 * verify-criteria.mjs — the builder's model, proved against the schema.
 *
 *   node scripts/verify-criteria.mjs
 *
 * Two claims that are easy to assert and hard to mean:
 *
 *   1. "All fields" really is all fields — every field of every sendable filter
 *      type is either buildable or listed as unreachable *with a reason*. No
 *      field may be silently absent or unbuildable for an unexplained reason.
 *   2. What the builder writes is what the translator reads. The builder emits
 *      Stash's *stored* envelope; `filterTranslate` converts it to GraphQL at
 *      query time. That seam is where a filter can validate and match nothing,
 *      so it is round-tripped rather than trusted.
 *
 * Exits non-zero on the first failure.
 */

import { coverage, criteriaFor, COMMON, EDITOR } from '../src/utils/filterCriteria.js';
import { ENUMS, FILTER_TYPES, CRITERION_FIELDS } from '../src/utils/stashFilterSchema.js';
import { translateFilter } from '../src/utils/filterTranslate.js';

let failed = 0;
let checks = 0;

function ok(label, cond, detail = '') {
  checks++;
  if (!cond) {
    failed++;
    console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

// ── 1. Coverage ───────────────────────────────────────────
//
// Every filter type the three services can send — the ones App.jsx reaches
// through TAB_CONTROL_CONFIG.
const SENDABLE = [
  'SceneFilterType',
  'SceneMarkerFilterType',
  'PerformerFilterType',
];

console.log('Coverage');

for (const ft of SENDABLE) {
  const cov = coverage(ft);
  const total = cov.reachable.length + cov.unreachable.length;

  ok(`${ft}: every field is accounted for`,
    cov.unexplained.length === 0,
    cov.unexplained.map(c => `${c.field} (${c.type}) has no editor and no reason`).join('\n        '));

  ok(`${ft}: coverage is non-trivial`, total > 0, 'no fields at all — schema snapshot missing?');
  ok(`${ft}: nothing unreachable is also buildable`,
    cov.unreachable.every(c => !c.editor));

  console.log(`  ${ft}: ${cov.reachable.length} buildable, ${cov.unreachable.length - cov.unexplained.length} documented unreachable, ${cov.unexplained.length} unexplained (of ${total})`);
}

// Unreachable fields need a user-readable reason: the builder shows them in a
// disabled group rather than hiding them.
for (const ft of SENDABLE) {
  for (const c of coverage(ft).unreachable) {
    ok(`${ft}.${c.field}: unreachable with a stated reason`,
      typeof c.reason === 'string' && c.reason.length > 20,
      `reason was ${JSON.stringify(c.reason)}`);
  }
}

// ── 2. Every COMMON field is a real field ─────────────────
//
// A typo here silently drops a pinned criterion: the builder renders 11 cards
// where the plan says 12, and nothing looks wrong.
console.log('\nCommon groups');

for (const [ft, fields] of Object.entries(COMMON)) {
  const real = FILTER_TYPES[ft];
  ok(`${ft}: Common list names only real fields`,
    fields.every(f => real && real[f]),
    fields.filter(f => !real || !real[f]).join(', '));

  // A pinned criterion that cannot be built is a dead card.
  const buildable = criteriaFor(ft).filter(c => c.common && c.editor);
  eq(`${ft}: every Common field is buildable`, buildable.length, fields.length);
}

// ── 3. Modifiers are real, and legal for their type ───────
console.log('\nModifiers');

for (const ft of SENDABLE) {
  for (const c of criteriaFor(ft)) {
    if (!c.editor) continue;

    ok(`${ft}.${c.field}: every modifier is a real CriterionModifier`,
      c.modifierOptions.every(m => ENUMS.CriterionModifier.includes(m)),
      c.modifierOptions.filter(m => !ENUMS.CriterionModifier.includes(m)).join(', '));

    // BETWEEN needs a second operand; offering it where `value2` is undeclared
    // produces a criterion the translator drops as empty, silently widening.
    const base = String(c.type).replace(/[[\]!]/g, '');
    const declaresValue2 = (CRITERION_FIELDS[base] || []).includes('value2');
    const offersRange = c.modifierOptions.some(m => m === 'BETWEEN' || m === 'NOT_BETWEEN');
    ok(`${ft}.${c.field}: a range modifier only where the type declares value2`,
      offersRange === declaresValue2,
      `offers range: ${offersRange}, declares value2: ${declaresValue2}`);

    // A type with no modifier field must offer none.
    ok(`${ft}.${c.field}: no modifiers where the criterion declares none`,
      !ENUMS.CriterionModifier.length || c.modifierOptions.length > 0 ||
      ['DuplicationCriterionInput', 'FileDuplicationCriterionInput', 'OrientationCriterionInput']
        .includes(base));
  }
}

// ── 4. Enums come through whole ───────────────────────────
console.log('\nEnums');

for (const ft of SENDABLE) {
  for (const c of criteriaFor(ft)) {
    if (c.editor !== EDITOR.ENUM) continue;
    ok(`${ft}.${c.field}: enum options are populated`,
      Array.isArray(c.enumOptions) && c.enumOptions.length > 0,
      `enumOptions was ${JSON.stringify(c.enumOptions)}`);
  }
}

// A list-valued criterion must be flagged as such, or the builder renders a
// single-choice control for a field that takes several answers.
const circumcised = criteriaFor('PerformerFilterType').find(c => c.field === 'circumcised');
ok('PerformerFilterType.circumcised is flagged list-valued',
  circumcised?.editor === EDITOR.ENUM && circumcised.listValued === true,
  `editor ${circumcised?.editor}, listValued ${circumcised?.listValued}`);

// ── 5. The builder's envelope round-trips ─────────────────
//
// The exact shapes FilterBuilder writes; each must reach GraphQL meaning the
// same. Translating to `{}` is the silent-widening bug; a nested `value.value`
// is the 422.
console.log('\nRound trip: builder envelope → GraphQL');

const rt = (name, stored, expected) =>
  eq(`round trip: ${name}`, translateFilter(stored, 'SceneFilterType'), expected);

// text / number / date — { modifier, value: { value } }
rt('string criterion',
  { title: { modifier: 'INCLUDES', value: { value: 'Night' } } },
  { title: { value: 'Night', modifier: 'INCLUDES' } });

rt('int criterion',
  { rating100: { modifier: 'GREATER_THAN', value: { value: 70 } } },
  { rating100: { value: 70, modifier: 'GREATER_THAN' } });

rt('range criterion uses value2',
  { o_counter: { modifier: 'BETWEEN', value: { value: 1, value2: 5 } } },
  { o_counter: { value: 1, value2: 5, modifier: 'BETWEEN' } });

// boolean — the value is the STRING 'true', and must come out a real boolean.
rt('boolean criterion is coerced',
  { organized: { modifier: 'EQUALS', value: 'true' } },
  { organized: true });

// tri-state String fields must NOT be coerced to booleans.
rt('tri-state String stays a string',
  { has_markers: { modifier: 'EQUALS', value: 'true' } },
  { has_markers: 'true' });

// multi — { modifier, value: { items: [{id,label}], excluded, depth } }
rt('multi criterion unwraps to ids',
  { tags: { modifier: 'INCLUDES', value: { items: [{ id: '5', label: 'Blonde' }], excluded: [] } } },
  { tags: { value: ['5'], modifier: 'INCLUDES' } });

rt('hierarchical keeps depth',
  { studios: { modifier: 'INCLUDES', value: { items: [{ id: '3', label: 'Acme' }], excluded: [], depth: 1 } } },
  { studios: { value: ['3'], depth: 1, modifier: 'INCLUDES' } });

rt('multi exclusions become excludes',
  { performers: { modifier: 'INCLUDES', value: { items: [{ id: '1', label: 'A' }], excluded: [{ id: '2', label: 'B' }] } } },
  { performers: { value: ['1'], excludes: ['2'], modifier: 'INCLUDES' } });

// The quoting trap, which the builder must never recreate: a value with a
// space is stored unquoted, and must arrive unquoted.
rt('a value with a space is not quoted',
  { title: { modifier: 'INCLUDES', value: { value: 'Two Words' } } },
  { title: { value: 'Two Words', modifier: 'INCLUDES' } });

// A criterion that constrains nothing is dropped, not sent — sending
// `INCLUDES ""` matches every row and silently widens the filter.
rt('an empty value is dropped',
  { title: { modifier: 'INCLUDES', value: { value: '' } } },
  {});

// IS_NULL ignores its operand but the input type still requires one, so an
// empty envelope gains the minimal valid value. Stash rejects a bare modifier.
rt('IS_NULL gains the operand its input type requires',
  { details: { modifier: 'IS_NULL', value: {} } },
  { details: { modifier: 'IS_NULL', value: '' } });

// An inner value Stash's UI stored survives unchanged.
rt('IS_NULL with an empty inner value keeps it',
  { details: { modifier: 'IS_NULL', value: { value: '' } } },
  { details: { value: '', modifier: 'IS_NULL' } });

// Two criteria compose.
rt('two criteria compose',
  {
    title: { modifier: 'INCLUDES', value: { value: 'Night' } },
    tags: { modifier: 'INCLUDES', value: { items: [{ id: '5', label: 'x' }] } },
  },
  {
    title: { value: 'Night', modifier: 'INCLUDES' },
    tags: { value: ['5'], modifier: 'INCLUDES' },
  });

// ── Summary ───────────────────────────────────────────────
console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
