#!/usr/bin/env node
/**
 * probe-filter-write.mjs — does the builder's envelope survive a save?
 *
 *   node scripts/probe-filter-write.mjs
 *
 * P2 adds the app's first *write* to Stash. Everything else it does is a read,
 * so this is the one place a mistake touches the user's library rather than
 * just showing them the wrong grid. Two things have to be true, and neither
 * can be settled by reading the schema:
 *
 *   1. `SaveFilterInput.object_filter` is a `Map` scalar. Whether it accepts
 *      the *stored* envelope `filterCriteria.js` builds — rather than the
 *      GraphQL shape, which is what the translator produces at query time —
 *      is a question only the server answers.
 *   2. Whatever it accepts, it must return it unchanged. A filter the app
 *      saves and cannot reopen is worse than no filter at all, and the
 *      failure would be silent: it would appear in the dropdown and load
 *      empty.
 *
 * THIS WRITES TO THE REAL SERVER, then deletes what it wrote. The probe filter
 * is named so that it is obvious in Stash's UI, and the delete runs in a
 * `finally` so a failure mid-probe still cleans up. If the delete itself
 * fails the script says so loudly rather than exiting quietly.
 *
 * Credentials come from the environment or .env.production, as the schema
 * generator does. Nothing is printed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = { ...process.env };
  if (env.VITE_STASH_URL && env.VITE_STASH_API_KEY) return env;
  try {
    for (const line of readFileSync(resolve(HERE, '../.env.production'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim();
    }
  } catch { /* the explicit-env path is the only option */ }
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
    headers: {
      'Content-Type': 'application/json',
      ...(env.VITE_STASH_API_KEY ? { ApiKey: env.VITE_STASH_API_KEY } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

const NAME = 'StashZen probe — safe to delete';

// The envelope the builder writes, covering each shape `criteriaFor` can
// produce. If only one shape round-tripped, a filter mixing them would still
// be broken, so all of them go in at once.
const STORED = {
  title: { modifier: 'INCLUDES', value: { value: 'probe' } },
  rating100: { modifier: 'GREATER_THAN', value: { value: 70 } },
  organized: { modifier: 'EQUALS', value: 'true' },
  has_markers: { modifier: 'EQUALS', value: 'true' },
  tags: { modifier: 'INCLUDES', value: { items: [{ id: '1', label: 'tag' }], excluded: [] } },
  studios: { modifier: 'INCLUDES', value: { items: [{ id: '1', label: 'studio' }], excluded: [], depth: 1 } },
  details: { modifier: 'IS_NULL', value: {} },
};

/**
 * Deep-compare that ignores key order.
 *
 * `object_filter` is a `Map` scalar and the server serialises it with keys
 * sorted, so a multi-select written `{items, excluded}` reads back
 * `{excluded, items}`. That is not a difference in the filter — it is the same
 * object — but `JSON.stringify` compares key order, so the first run of this
 * probe reported two failures that were entirely its own. Comparing
 * canonically is the fix, and it is the same one `test-translate.mjs` uses.
 */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = canonical(v[k]); return acc; }, {});
  }
  return v;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

let createdId = null;
let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) { failed++; console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
  else console.log(`ok    ${label}`);
};

try {
  // A pre-existing probe would mean a previous run died between the write and
  // the delete. Say so rather than silently accumulating them.
  const before = await gql('{ findSavedFilters(mode: SCENES) { id name } }');
  const stale = (before.findSavedFilters || []).filter(f => f.name === NAME);
  if (stale.length) {
    console.log(`note: ${stale.length} leftover probe filter(s) from an earlier run — removing`);
    for (const s of stale) await gql('mutation($id:ID!){destroySavedFilter(input:{id:$id})}', { id: s.id });
  }

  // 1. Create.
  const saved = await gql(
    `mutation($input: SaveFilterInput!) { saveFilter(input: $input) { id name object_filter } }`,
    { input: { mode: 'SCENES', name: NAME, object_filter: STORED, find_filter: { sort: 'created_at', direction: 'DESC' } } },
  );
  createdId = saved?.saveFilter?.id;
  ok('saveFilter returned an id', !!createdId, `got ${JSON.stringify(saved)}`);
  if (!createdId) throw new Error('no id — cannot continue');

  // 2. Read back through the same query the app uses.
  const after = await gql('{ findSavedFilters(mode: SCENES) { id name object_filter find_filter { q page per_page sort direction } } }');
  const mine = (after.findSavedFilters || []).find(f => String(f.id) === String(createdId));
  ok('the filter is listed after saving', !!mine);
  if (!mine) throw new Error('not listed — cannot continue');

  // `object_filter` is a Map scalar: it may arrive as an object or as a JSON
  // string, which is exactly what filterService.parseObjectFilter defends
  // against. Normalise the same way before comparing.
  const back = typeof mine.object_filter === 'string' ? JSON.parse(mine.object_filter) : mine.object_filter;

  // 3. THE ONE THAT MATTERS. Byte-for-byte, so a dropped or rewritten key
  //    shows up. Compared key by key to name what broke.
  for (const key of Object.keys(STORED)) {
    ok(`  ${key} round-trips unchanged`,
      same(back?.[key], STORED[key]),
      `wrote ${JSON.stringify(STORED[key])}\n        read  ${JSON.stringify(back?.[key])}`);
  }
  // The key SET, not its order. `canonical` sorts object keys but not array
  // elements — array order is data — so the two `Object.keys` lists being
  // differently ordered is expected here, and comparing them raw (with a
  // message that sorted both before printing) made this check fail on a
  // difference it then declined to show.
  const wroteKeys = Object.keys(STORED).sort();
  const readKeys = Object.keys(back || {}).sort();
  ok('the same key set came back',
    JSON.stringify(wroteKeys) === JSON.stringify(readKeys),
    `missing: ${wroteKeys.filter(k => !readKeys.includes(k)).join(', ') || '(none)'}` +
    `\n        unexpected: ${readKeys.filter(k => !wroteKeys.includes(k)).join(', ') || '(none)'}`);

  ok('find_filter round-trips', mine.find_filter?.sort === 'created_at',
    JSON.stringify(mine.find_filter));

  // 4. Update in place — the id must be honoured rather than forking a copy.
  const renamed = await gql(
    `mutation($input: SaveFilterInput!) { saveFilter(input: $input) { id name } }`,
    { input: { id: createdId, mode: 'SCENES', name: NAME, object_filter: { title: { modifier: 'EQUALS', value: { value: 'two' } } } } },
  );
  ok('saving with an id updates rather than duplicates',
    String(renamed?.saveFilter?.id) === String(createdId),
    `was ${createdId}, got ${renamed?.saveFilter?.id}`);

  const listed = await gql('{ findSavedFilters(mode: SCENES) { id name } }');
  const copies = (listed.findSavedFilters || []).filter(f => f.name === NAME);
  ok('exactly one copy exists after the update', copies.length === 1, `found ${copies.length}`);
} catch (e) {
  failed++;
  console.log(`FAIL  probe threw: ${e.message}`);
} finally {
  if (createdId) {
    try {
      const d = await gql('mutation($id:ID!){destroySavedFilter(input:{id:$id})}', { id: createdId });
      const gone = await gql('{ findSavedFilters(mode: SCENES) { id } }');
      const still = (gone.findSavedFilters || []).some(f => String(f.id) === String(createdId));
      ok('the probe filter was deleted', d?.destroySavedFilter === true && !still,
        `destroy returned ${d?.destroySavedFilter}, still listed: ${still}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  COULD NOT CLEAN UP — "${NAME}" (id ${createdId}) is still in your Stash. ${e.message}`);
    }
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nprobe passed');
process.exit(failed ? 1 : 0);
