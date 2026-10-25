#!/usr/bin/env node
/**
 * test-criterion-draft.mjs — pure-function tests for criterionDraft.js
 *
 *   node scripts/test-criterion-draft.mjs
 *
 * Three functions decide what a built filter contains: `blankCriterion` seeds
 * a row, `seedCriterion` converts a GraphQL-shaped working filter into the
 * stored envelope, and `effectiveCriteria` decides which rows are real enough
 * to send. Each branch is unreachable from the harness (which builds filters
 * through the DOM); the boolean and list-valued-enum branches have shipped
 * broken before.
 */

import {
  blankCriterion, seedCriterion, isEffective, effectiveCriteria,
} from '../src/components/filterBuilder/criterionDraft.js';
import { EDITOR } from '../src/utils/filterCriteria.js';

let failed = 0;
let passed = 0;

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(v[k]))
      .join(',') + '}';
  }
  return JSON.stringify(v);
}

function check(label, actual, expected) {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
}

// Minimal descriptors — only the fields the functions read.
const textDesc = { field: 'title', editor: EDITOR.TEXT, modifierOptions: ['MATCHES_REGEX', 'IS_NULL', 'NOT_NULL'] };
const multiDesc = { field: 'tags', editor: EDITOR.MULTI, modifierOptions: ['INCLUDES', 'EXCLUDES'] };
const hierDesc = { field: 'tags', editor: EDITOR.HIERARCHICAL, modifierOptions: ['INCLUDES'] };
const enumDesc = { field: 'resolution', editor: EDITOR.ENUM, modifierOptions: ['EQUALS'], listValued: false };
const listEnumDesc = { field: 'circumcised', editor: EDITOR.ENUM, modifierOptions: ['EQUALS'], listValued: true };
const boolDesc = { field: 'organized', editor: EDITOR.BOOLEAN, modifierOptions: ['EQUALS', 'NOT_EQUALS'] };
const triDesc = { field: 'has_markers', editor: EDITOR.TRI, modifierOptions: ['EQUALS', 'NOT_EQUALS'] };
const numberDesc = { field: 'duration', editor: EDITOR.NUMBER, modifierOptions: ['GREATER_THAN', 'BETWEEN'] };
const stashIdDesc = { field: 'stash_id', editor: EDITOR.STASH_ID, modifierOptions: ['EQUALS'] };
const stashIdsDesc = { field: 'stash_ids', editor: EDITOR.STASH_IDS, modifierOptions: ['EQUALS'] };
const noEditorDesc = { field: 'weird', editor: null, modifierOptions: [] };

console.log('blankCriterion');
check('boolean starts Yes', blankCriterion(boolDesc), { modifier: 'EQUALS', value: 'true' });
check('tri starts Yes', blankCriterion(triDesc), { modifier: 'EQUALS', value: 'true' });
check('multi starts with empty include set', blankCriterion(multiDesc),
  { modifier: 'INCLUDES', value: { items: [], excluded: [] } });
check('hierarchical starts with empty include set', blankCriterion(hierDesc),
  { modifier: 'INCLUDES', value: { items: [], excluded: [] } });
check('scalar enum starts empty string', blankCriterion(enumDesc),
  { modifier: 'EQUALS', value: { value: '' } });
check('list-valued enum starts empty array', blankCriterion(listEnumDesc),
  { modifier: 'EQUALS', value: { value: [] } });
check('operand editor starts with an empty object', blankCriterion(textDesc),
  { modifier: 'MATCHES_REGEX', value: {} });
check('no modifiers starts with null', blankCriterion({ ...textDesc, modifierOptions: [] }),
  { modifier: null, value: {} });

console.log('seedCriterion');
check('null passes through', seedCriterion(textDesc, null), null);
check('a non-object passes through', seedCriterion(textDesc, 'oops'), 'oops');
const stored = { modifier: 'MATCHES_REGEX', value: { value: 'x' } };
check('a stored envelope passes through unchanged', seedCriterion(textDesc, stored), stored);
check('a stored boolean envelope is left alone', seedCriterion(boolDesc, { modifier: 'EQUALS', value: 'false' }),
  { modifier: 'EQUALS', value: 'false' });
check('a nullary criterion drops its operand', seedCriterion(textDesc, { modifier: 'IS_NULL', value: 'x' }),
  { modifier: 'IS_NULL', value: {} });
check('boolean GraphQL value becomes a string', seedCriterion(boolDesc, { modifier: 'NOT_EQUALS', value: false }),
  { modifier: 'NOT_EQUALS', value: 'false' });
check('boolean without a modifier defaults to EQUALS', seedCriterion(boolDesc, { value: true }),
  { modifier: 'EQUALS', value: 'true' });
check('tri is converted the same way', seedCriterion(triDesc, { modifier: 'EQUALS', value: 'false' }),
  { modifier: 'EQUALS', value: 'false' });
check('multi collects items, excludes and depth', seedCriterion(multiDesc,
  { modifier: 'EXCLUDES', value: [1, 2], excludes: [3], depth: 2 }),
  { modifier: 'EXCLUDES', value: { items: [1, 2], excluded: [3], depth: 2 } });
check('multi without excludes starts empty', seedCriterion(hierDesc,
  { modifier: 'INCLUDES', value: [7] }),
  { modifier: 'INCLUDES', value: { items: [7], excluded: [] } });
check('stash id reads endpoint and stash_id', seedCriterion(stashIdDesc,
  { modifier: 'EQUALS', endpoint: '/scenes', stash_id: '42' }),
  { modifier: 'EQUALS', value: { endpoint: '/scenes', stashID: '42' } });
check('stash ids reads stash_ids', seedCriterion(stashIdsDesc,
  { modifier: 'EQUALS', endpoint: '/scenes', stash_ids: '4,2' }),
  { modifier: 'EQUALS', value: { endpoint: '/scenes', stashIDs: '4,2' } });
check('stash id keeps camelCase spellings', seedCriterion(stashIdDesc,
  { modifier: 'EQUALS', endpoint: '/x', stashID: '9' }),
  { modifier: 'EQUALS', value: { endpoint: '/x', stashID: '9' } });
check('scalar enum keeps its value', seedCriterion(enumDesc,
  { modifier: 'EQUALS', value: 'FULL_HD' }),
  { modifier: 'EQUALS', value: { value: 'FULL_HD' } });
check('list-valued enum discards a scalar (the request side sends a list)',
  seedCriterion(listEnumDesc, { modifier: 'EQUALS', value: 'CUT' }),
  { modifier: 'EQUALS', value: { value: [] } });
check('list-valued enum keeps a list', seedCriterion(listEnumDesc,
  { modifier: 'EQUALS', value: ['CUT'] }),
  { modifier: 'EQUALS', value: { value: ['CUT'] } });
check('plain operand carries value and value2', seedCriterion(numberDesc,
  { modifier: 'BETWEEN', value: 70, value2: 90 }),
  { modifier: 'BETWEEN', value: { value: 70, value2: 90 } });
check('a field with no editor is left alone', seedCriterion(noEditorDesc,
  { modifier: 'EQUALS', value: 1 }),
  { modifier: 'EQUALS', value: 1 });

console.log('isEffective');
check('empty text is not effective', isEffective(textDesc, { modifier: 'MATCHES_REGEX', value: { value: '' } }), false);
check('filled text is effective', isEffective(textDesc, { modifier: 'MATCHES_REGEX', value: { value: 'x' } }), true);
check('zero is a real number', isEffective(numberDesc, { modifier: 'BETWEEN', value: { value: 0, value2: 5 } }), true);
check('a nullary criterion is effective with no operand',
  isEffective(textDesc, { modifier: 'IS_NULL', value: {} }), true);
check('empty multi is not effective', isEffective(multiDesc, { modifier: 'INCLUDES', value: { items: [] } }), false);
check('filled multi is effective', isEffective(multiDesc,
  { modifier: 'INCLUDES', value: { items: [{ id: '1' }] } }), true);
check('empty list-valued enum is not effective',
  isEffective(listEnumDesc, { modifier: 'EQUALS', value: { value: [] } }), false);
check('filled list-valued enum is effective',
  isEffective(listEnumDesc, { modifier: 'EQUALS', value: { value: ['CUT'] } }), true);
check('boolean true is effective', isEffective(boolDesc, { modifier: 'EQUALS', value: 'true' }), true);
check('boolean false is effective', isEffective(boolDesc, { modifier: 'EQUALS', value: 'false' }), true);
check('a missing boolean operand is not effective',
  isEffective(boolDesc, { modifier: 'EQUALS', value: undefined }), false);
check('an empty-string boolean is not effective',
  isEffective(triDesc, { modifier: 'EQUALS', value: '' }), false);
check('stash id needs an endpoint and an id',
  isEffective(stashIdDesc, { modifier: 'EQUALS', value: { endpoint: '', stashID: '9' } }), false);
check('stash id with both is effective',
  isEffective(stashIdDesc, { modifier: 'EQUALS', value: { endpoint: '/x', stashID: '9' } }), true);
check('stash ids: an empty id is not effective',
  isEffective(stashIdsDesc, { modifier: 'EQUALS', value: { endpoint: '/x', stashIDs: '' } }), false);

console.log('effectiveCriteria');
const byField = new Map([
  ['title', textDesc], ['duration', numberDesc], ['tags', multiDesc],
  ['resolution', listEnumDesc], ['organized', boolDesc], ['stash_id', stashIdDesc],
]);
const result = effectiveCriteria(
  ['title', 'duration', 'tags', 'resolution', 'organized', 'stash_id', 'gone'],
  {
    title: { modifier: 'MATCHES_REGEX', value: { value: 'x' } },
    duration: { modifier: 'BETWEEN', value: { value: 0, value2: 5 } },
    tags: { modifier: 'INCLUDES', value: { items: [] } },
    resolution: { modifier: 'EQUALS', value: { value: ['CUT'] } },
    organized: { modifier: 'EQUALS', value: 'false' },
    stash_id: { modifier: 'EQUALS', value: { endpoint: '', stashID: '9' } },
    gone: { modifier: 'EQUALS', value: { value: 'z' } },
  },
  byField,
);
check('only the real criteria come out, in row order',
  Object.keys(result), ['title', 'duration', 'resolution', 'organized']);
check('the values are carried unchanged', result.duration,
  { modifier: 'BETWEEN', value: { value: 0, value2: 5 } });
check('a field with no entry in criteria is skipped',
  effectiveCriteria(['title'], {}, byField), {});
check('a field missing from the schema map is skipped',
  effectiveCriteria(['gone'], { gone: { modifier: 'EQUALS', value: { value: 'z' } } }, byField), {});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
