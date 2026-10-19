#!/usr/bin/env node
/**
 * test-request-key.mjs — the listing request identity
 *
 *   node scripts/test-request-key.mjs
 *
 * `usePagedList` resets to page 1 when `pageRequestKey(...)` changes, so this
 * string is now the only thing standing between a sort/filter change and a
 * stale list. The checks pin the two directions that matter: every input that
 * belongs to the request must move the key, and content that Stash treats as
 * the same request must not.
 *
 * The encoding group is the format's own contract. JSON quoting is what stops
 * a value from forging a part boundary — a separator-joined string would not —
 * so the `|` and quote cases are here to make a future "make the key shorter"
 * change prove it stayed safe.
 *
 * No framework, same as test-key-routing.mjs.
 */

import { pageRequestKey } from '../src/utils/requestKey.js';

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

const A = { sort: 'title', order: 'asc', filter: { tags: ['a'] }, q: '' };
const key = (o) => pageRequestKey(o.sort, o.order, o.filter, o.q);

// ── Stability ───────────────────────────────────────────────
check('identical inputs produce an identical key',
  key(A) === key(A), key(A));
check('a freshly built, content-equal filter produces the same key',
  key(A) === pageRequestKey('title', 'asc', { tags: ['a'] }, ''),
  `${key(A)} vs ${pageRequestKey('title', 'asc', { tags: ['a'] }, '')}`);

// ── Every part of the request moves the key ─────────────────
check('sort changes the key', key({ ...A, sort: 'updated_at' }) !== key(A));
check('order changes the key', key({ ...A, order: 'desc' }) !== key(A));
check('query changes the key', key({ ...A, q: 'alpha' }) !== key(A));
check('filter content changes the key',
  key({ ...A, filter: { tags: ['b'] } }) !== key(A));

// ── Encoding cannot be forged ───────────────────────────────
check('a separator-like value cannot forge a boundary',
  pageRequestKey('a|b', 'c') !== pageRequestKey('a', 'b|c'),
  `${pageRequestKey('a|b', 'c')} vs ${pageRequestKey('a', 'b|c')}`);
check('quotes are escaped by the encoding',
  pageRequestKey('a","b', '') !== pageRequestKey('a', '"b"'),
  pageRequestKey('a","b', ''));
check('undefined and null encode alike (documented nuance)',
  pageRequestKey(undefined) === pageRequestKey(null),
  `${pageRequestKey(undefined)} vs ${pageRequestKey(null)}`);
check('the key is a JSON array string',
  typeof key(A) === 'string' && key(A).startsWith('['), key(A));

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
