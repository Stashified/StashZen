#!/usr/bin/env node
/**
 * gen-filter-schema.mjs — regenerate src/utils/stashFilterSchema.js
 *
 * Introspects a live Stash server and writes the field → GraphQL-input-type
 * map the filter translator dispatches on. Run this after upgrading Stash;
 * the generated file is committed so the app never introspects at runtime.
 *
 *   node scripts/gen-filter-schema.mjs
 *
 * Credentials come from the environment (VITE_STASH_URL / VITE_STASH_API_KEY)
 * or, failing that, from .env.production. Nothing is ever printed.
 *
 * Traversal is deliberately bounded to *filter* types: starting at the three
 * roots below it follows fields whose type ends in `FilterType` (so nested
 * filters like SceneFilterType.tags_filter are covered) and separately
 * collects the `*CriterionInput` types those fields reference. It does not
 * walk the whole schema — `SceneFilterType` ↔ `PerformerFilterType` reference
 * each other, and the criterion types are the only other thing we need.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/utils/stashFilterSchema.js');

// The filter types the app can send. Mirrors FILTER_MODE in filterService.js.
const ROOTS = ['SceneFilterType', 'SceneMarkerFilterType', 'PerformerFilterType'];

// ── credentials ───────────────────────────────────────────
function loadEnv() {
  const env = { ...process.env };
  if (env.VITE_STASH_URL && env.VITE_STASH_API_KEY) return env;
  try {
    for (const line of readFileSync(resolve(HERE, '../.env.production'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim();
    }
  } catch {
    // No .env.production — the explicit-env path above is the only option.
  }
  return env;
}

const env = loadEnv();
if (!env.VITE_STASH_URL) {
  console.error('No VITE_STASH_URL. Set it in the environment or in .env.production.');
  process.exit(1);
}

const ENDPOINT = env.VITE_STASH_URL.replace(/\/+$/, '') + '/graphql';

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(env.VITE_STASH_API_KEY ? { ApiKey: env.VITE_STASH_API_KEY } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${ENDPOINT}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

/** Render a GraphQL type reference, e.g. `[TagFilterType!]`. */
function typeName(t) {
  if (!t) return null;
  if (t.kind === 'NON_NULL') return typeName(t.ofType) + '!';
  if (t.kind === 'LIST') return '[' + typeName(t.ofType) + ']';
  return t.name;
}

const BASE = t => t.replace(/[[\]!]/g, '');

const FIELDS_QUERY = `
  query($n: String!) {
    __type(name: $n) {
      kind
      inputFields { name type { kind name ofType { kind name ofType { kind name } } } }
    }
  }
`;

async function inputFields(name) {
  const d = await gql(FIELDS_QUERY, { n: name });
  const t = d.__type;
  if (!t || t.kind !== 'INPUT_OBJECT') return null;
  return (t.inputFields || []).map(f => ({ name: f.name, type: typeName(f.type) }));
}

// ── walk ──────────────────────────────────────────────────
const filterTypes = {};
const criterionTypes = new Set();
const queue = [...ROOTS];

while (queue.length) {
  const name = queue.shift();
  if (filterTypes[name]) continue;

  const fields = await inputFields(name);
  if (!fields) {
    console.warn(`  ! ${name} is not an input object — skipped`);
    continue;
  }

  filterTypes[name] = Object.fromEntries(fields.map(f => [f.name, f.type]));

  for (const f of fields) {
    const base = BASE(f.type);
    if (base.endsWith('FilterType')) queue.push(base);
    else if (base.endsWith('CriterionInput')) criterionTypes.add(base);
  }
}

// Criterion shapes. Three things the translator needs:
//   - which types can't carry a modifier (emitting one is a 422)
//   - which take a list in `value` (a bare scalar has to be wrapped)
//   - the declared field list, so a key that doesn't belong to the target
//     type (e.g. `depth` on a plain MultiCriterionInput) is pruned rather
//     than sent and rejected
const noModifier = [];
const listValue = [];
const criterionFields = {};
// Enum types a criterion's `modifier` or `value` is declared as. The builder
// needs these to render the dropdown, and hardcoding them would reintroduce
// exactly the field-list problem this file exists to avoid: the modifier set
// is per-criterion-type (a Duplication has no modifier at all; a Hierarchical
// multi takes INCLUDES/EXCLUDES where a String takes MATCHES_REGEX).
const enumRefs = new Set();
for (const name of [...criterionTypes].sort()) {
  const fields = await inputFields(name);
  if (!fields) continue;
  criterionFields[name] = fields.map(f => f.name).sort();
  if (!fields.some(f => f.name === 'modifier')) noModifier.push(name);
  const value = fields.find(f => f.name === 'value');
  if (value && value.type.startsWith('[')) listValue.push(name);
  for (const key of ['modifier', 'value', 'value2']) {
    const f = fields.find(x => x.name === key);
    if (f) enumRefs.add(BASE(f.type));
  }
}

// Resolve the ones that are actually enums. A scalar (String, Int, Boolean)
// has no enumValues and is dropped here rather than guessed at.
const ENUM_QUERY = `
  query($n: String!) { __type(name: $n) { kind enumValues { name } } }
`;
const enums = {};
for (const name of [...enumRefs].sort()) {
  const d = await gql(ENUM_QUERY, { n: name });
  const t = d.__type;
  if (t?.kind === 'ENUM' && t.enumValues?.length) {
    enums[name] = t.enumValues.map(v => v.name).sort();
  }
}

const version = (await gql('{ version { version } }'))?.version?.version || 'unknown';
const capturedAt = new Date().toISOString().slice(0, 10);

// ── emit ──────────────────────────────────────────────────
const banner = `/**
 * stashFilterSchema.js — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * The field → GraphQL input type map for every filter type the app can send.
 * \`filterTranslate.js\` dispatches on these type names: it is what tells a
 * Boolean scalar from a String one, a plain MultiCriterionInput from a
 * HierarchicalMultiCriterionInput (only the latter takes \`depth\`), and a
 * nested *FilterType from a criterion.
 *
 * Regenerate after a Stash upgrade:
 *
 *     node scripts/gen-filter-schema.mjs
 *
 * Generated:   ${capturedAt}
 * Stash:       ${version}
 * Endpoint:    ${env.VITE_STASH_URL}
 * Filter types walked: ${Object.keys(filterTypes).length}
 * Enums captured: ${Object.keys(enums).length}
 *
 * Committed rather than introspected at runtime: the TV is on the same LAN,
 * but a cold start should never pay for a round-trip it can't use, and a
 * pinned snapshot makes a translator change reviewable as a diff.
 *
 * The map is additive and read-only at runtime. A field missing from here is
 * NOT an error — filterTranslate.js passes unrecognised fields through
 * verbatim, so a filter saved by a newer Stash still reaches the server.
 */

`;

const body = [
  `export const SCHEMA_VERSION = ${JSON.stringify(version)};`,
  `export const SCHEMA_CAPTURED_AT = ${JSON.stringify(capturedAt)};`,
  '',
  '/** filterTypeName → { fieldName: GraphQL input type } */',
  'export const FILTER_TYPES = {',
  ...Object.keys(filterTypes).sort().map(t => {
    const fields = filterTypes[t];
    const lines = Object.keys(fields).sort().map(f => `    ${f}: '${fields[f]}',`);
    return `  ${t}: {\n${lines.join('\n')}\n  },`;
  }),
  '};',
  '',
  '/** Criterion types with no `modifier` field — emitting one is a 422. */',
  `export const CRITERIA_WITHOUT_MODIFIER = new Set(${JSON.stringify(noModifier)});`,
  '',
  '/** Criterion types whose `value` is a list — a bare scalar must be wrapped. */',
  `export const LIST_VALUED_CRITERIA = new Set(${JSON.stringify(listValue)});`,
  '',
  '/**',
  ' * criterionTypeName → its declared field names.',
  ' *',
  ' * The translator prunes anything it emits that this list does not declare.',
  ' * That is what keeps a stray key (the clearest example being `depth`, which',
  ' * only the Hierarchical variants accept) from turning the whole request into',
  ' * an opaque 422.',
  ' */',
  'export const CRITERION_FIELDS = {',
  ...Object.keys(criterionFields).sort().map(t => `  ${t}: [${criterionFields[t].map(f => `'${f}'`).join(', ')}],`),
  '};',
  '',
  '/** Type names that are themselves nested filters (recurse into them). */',
  'export const FILTER_TYPE_NAMES = new Set(Object.keys(FILTER_TYPES));',
  '',
  '/**',
  ' * Enum name → its values, for every enum a criterion declares as its',
  ' * `modifier` or `value`. `CriterionModifier` is here because every criterion',
  ' * declares its `modifier` as that one enum; the rest are the value enums',
  ' * (`ResolutionEnum`, `GenderEnum`, …).',
  ' *',
  ' * Captured rather than hardcoded for the same reason the field map is: the',
  ' * set of legal modifiers is per-criterion-type, and a hardcoded list is how',
  ' * a translator bug becomes a 422 nobody can read.',
  ' */',
  'export const ENUMS = {',
  ...Object.keys(enums).sort().map(t => `  ${t}: [${enums[t].map(v => `'${v}'`).join(', ')}],`),
  '};',
  '',
].join('\n');

writeFileSync(OUT, banner + body, 'utf8');

console.log(`Wrote ${OUT}`);
console.log(`  Stash ${version}, captured ${capturedAt}`);
console.log(`  ${Object.keys(filterTypes).length} filter types, ${criterionTypes.size} criterion types`);
console.log(`  no-modifier: ${noModifier.join(', ') || '(none)'}`);
console.log(`  list-valued: ${listValue.join(', ') || '(none)'}`);
console.log(`  enums: ${Object.keys(enums).join(', ') || '(none)'}`);
