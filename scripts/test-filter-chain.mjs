#!/usr/bin/env node
/**
 * test-filter-chain.mjs — the row's D-pad chain against the editor's controls
 *
 *   node scripts/test-filter-chain.mjs
 *
 * CriterionRow gives each control in a criterion row an explicit left/right
 * neighbour (`nextId`), because `.rowBody` wraps: once a row takes a second
 * visual line, the geometry reads Left from a wrapped control as "whatever is
 * to the left on the screen", and the answer is a footer button. The chain
 * must list exactly what the editor renders, in DOM order. A chain entry
 * naming a control that was not rendered and a rendered control missing from
 * the chain both fall back to that geometry, so the two mistakes look alike —
 * and only a remote shows either.
 *
 * Each editor module exports the two descriptions independently: `parts` is
 * what CriterionRow renders, `chainIds` is what it wires. This asserts they
 * agree for every editor kind, with and without an operand, and for the
 * range/non-range pair. No framework, same as test-translate.mjs.
 */

import { criteriaFor, EDITOR } from '../src/utils/filterCriteria.js';
import {
  editorFor, editorParts, editorChainIds, PART_KINDS,
} from '../src/components/filterBuilder/editors/index.js';

let failed = 0;
let passed = 0;

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function check(label, pass, detail = '') {
  if (pass) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`);
  }
}

// Real descriptors from the schema the app ships, looked up by field so a
// schema regeneration that renames one fails loudly here instead of silently
// testing a different editor.
const descs = criteriaFor('SceneFilterType');
const byField = (field) => {
  const d = descs.find(x => x.field === field);
  if (!d) throw new Error(`no descriptor for ${field} in SceneFilterType`);
  return d;
};

const valueCrit = { modifier: 'EQUALS', value: { value: '5', value2: '9', items: [{ label: 'Tag A' }] } };
const boolCrit = { modifier: 'EQUALS', value: 'true' };
const openCrit = { modifier: 'IS_NULL', value: {} };
const betweenCrit = { modifier: 'BETWEEN', value: { value: '1', value2: '2' } };

function checkCase(label, desc, criterion, expected) {
  const chain = editorChainIds(desc.field, desc, criterion);
  check(`${label}: chain`, same(chain, expected),
    `expected [${expected.join(', ')}]  actual [${chain.join(', ')}]`);

  const parts = editorParts(desc.field, desc, criterion);
  const rendered = parts.map(p => p.id);
  check(`${label}: rendered ids match the chain`, same(rendered, chain),
    `rendered [${rendered.join(', ')}]  chain [${chain.join(', ')}]`);

  const badKinds = parts.filter(p => !PART_KINDS.includes(p.kind));
  check(`${label}: every part has a kind CriterionRow renders`, badKinds.length === 0,
    `unknown kinds: ${badKinds.map(p => p.kind).join(', ')}`);
}

console.log('registry');
for (const kind of Object.values(EDITOR)) {
  check(`every editor kind has a module: ${kind}`, Boolean(editorFor(kind)));
}
check('a null editor has no module', editorFor(null) === null);

console.log('chain vs rendered controls');
checkCase('TEXT', byField('title'), valueCrit, ['fb-val-title']);
checkCase('PHASH', byField('phash_distance'), valueCrit, ['fb-val-phash_distance']);
checkCase('NUMBER', byField('duration'), valueCrit, ['fb-val-duration']);
checkCase('NUMBER BETWEEN', byField('duration'), betweenCrit,
  ['fb-val-duration', 'fb-val2-duration']);
checkCase('NUMBER BETWEEN, range unsupported', { ...byField('duration'), supportsRange: false },
  betweenCrit, ['fb-val-duration']);
checkCase('DATE BETWEEN', byField('date'), betweenCrit, ['fb-val-date', 'fb-val2-date']);
checkCase('TIMESTAMP BETWEEN', byField('created_at'), betweenCrit,
  ['fb-val-created_at', 'fb-val2-created_at']);
checkCase('ENUM', byField('resolution'), valueCrit, ['fb-val-resolution']);
checkCase('BOOLEAN', byField('organized'), boolCrit, ['fb-val-organized']);
checkCase('MULTI', byField('performers'), valueCrit, ['fb-pick-performers']);
checkCase('HIERARCHICAL', byField('tags'), valueCrit, ['fb-pick-tags', 'fb-depth-tags']);
checkCase('STASH_ID', byField('stash_id_endpoint'), valueCrit,
  ['fb-ep-stash_id_endpoint', 'fb-sid-stash_id_endpoint']);
checkCase('STASH_IDS', byField('stash_ids_endpoint'), valueCrit,
  ['fb-ep-stash_ids_endpoint', 'fb-sid-stash_ids_endpoint']);

console.log('no operand');
checkCase('TEXT with a nullary modifier renders nothing', byField('title'), openCrit, []);
checkCase('MULTI with a nullary modifier renders nothing', byField('performers'), openCrit, []);
checkCase('HIERARCHICAL with a nullary modifier renders nothing', byField('tags'), openCrit, []);
checkCase('STASH_ID with a nullary modifier renders nothing', byField('stash_id_endpoint'), openCrit, []);
// BOOLEAN and TRI have no operand to gate on; their Choice is still rendered.
checkCase('BOOLEAN with a nullary modifier keeps its control', byField('organized'), openCrit,
  ['fb-val-organized']);
checkCase('TRI with a nullary modifier keeps its control', byField('has_markers'), openCrit,
  ['fb-val-has_markers']);

console.log('no editor');
checkCase('a field with no editor renders nothing', { field: 'weird', editor: null },
  valueCrit, []);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
