#!/usr/bin/env node
/**
 * test-translate.mjs — pure-function tests for filterTranslate.js
 *
 *   node scripts/test-translate.mjs
 *
 * `verify-filters.mjs` proves the translator against the *real* saved filters,
 * but those only exercise ten fields, all string/int/multi. The Boolean,
 * list-valued enum, nested AND/OR and newer-Stash branches are unreachable from
 * that data and would otherwise ship untested. Exits non-zero on first failure.
 */

import { translateFilter, stripWrappingQuotes } from '../src/utils/filterTranslate.js';
import { ENUMS } from '../src/utils/stashFilterSchema.js';

let failed = 0;
let passed = 0;

/** Order-insensitive deep comparison — see the note in verify-filters.mjs. */
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

const t = (raw, type = 'SceneFilterType') => translateFilter(raw, type);

console.log('\n── quote stripping');
check('strips one wrapping pair', stripWrappingQuotes('"/a b/c"'), '/a b/c');
check('leaves an unquoted value alone', stripWrappingQuotes('/a b/c'), '/a b/c');
check('is not recursive', stripWrappingQuotes('""'), '');
check('ignores a lone quote', stripWrappingQuotes('"'), '"');
check('ignores non-strings', stripWrappingQuotes(42), 42);

console.log('\n── Boolean fields (the "false" string trap)');
check('unwraps and coerces "false"',
  t({ organized: { modifier: 'EQUALS', value: 'false' } }), { organized: false });
check('unwraps and coerces "true"',
  t({ organized: { modifier: 'EQUALS', value: 'true' } }), { organized: true });
check('passes a real boolean through',
  t({ organized: true }), { organized: true });
check('drops a boolean it cannot interpret',
  t({ organized: { modifier: 'EQUALS', value: 'maybe' } }), {});

console.log('\n── bare String fields (must NOT be coerced to Boolean)');
check('has_markers stays a string',
  t({ has_markers: { modifier: 'INCLUDES', value: 'true' } }), { has_markers: 'true' });
check('is_missing stays a string',
  t({ is_missing: { modifier: 'EQUALS', value: 'url' } }), { is_missing: 'url' });
check('a null modifier is dropped',
  t({ is_missing: { modifier: null, value: { value: 'url' } } }), { is_missing: 'url' });

console.log('\n── scalar criteria');
check('unwraps {value:{value}}',
  t({ play_duration: { modifier: 'LESS_THAN', value: { value: 1 } } }),
  { play_duration: { value: 1, modifier: 'LESS_THAN' } });
check('de-quotes a string criterion',
  t({ path: { modifier: 'INCLUDES', value: '"/library/some folder"' } }),
  { path: { value: '/library/some folder', modifier: 'INCLUDES' } });
check('keeps value2',
  t({ last_played_at: { modifier: 'BETWEEN', value: { value: '1', value2: '2' } } }),
  { last_played_at: { value: '1', value2: '2', modifier: 'BETWEEN' } });

console.log('\n── multi criteria');
check('hierarchical keeps depth and renames excluded → excludes',
  t({ tags: { modifier: 'INCLUDES', value: { depth: 0, excluded: [], items: [{ id: '7', label: 'x' }] } } }),
  { tags: { value: ['7'], depth: 0, modifier: 'INCLUDES' } });
check('plain multi drops depth (MultiCriterionInput has no such field)',
  t({ performers: { modifier: 'INCLUDES_ALL', value: { items: [{ id: '7', label: 'x' }], depth: 5 } } }),
  { performers: { value: ['7'], modifier: 'INCLUDES_ALL' } });
check('excluded entries become excludes and are unwrapped',
  t({ tags: { modifier: 'EXCLUDES', value: { items: [{ id: '1' }], excluded: [{ id: '2' }] } } }),
  { tags: { value: ['1'], excludes: ['2'], modifier: 'EXCLUDES' } });
check('keeps an exclusion-only multi (empty items, non-empty excluded)',
  t({ tags: { modifier: 'EXCLUDES', value: { items: [], excluded: [{ id: '2' }] } } }),
  { tags: { value: [], excludes: ['2'], modifier: 'EXCLUDES' } });
check('still drops a multi with neither items nor exclusions',
  t({ tags: { modifier: 'INCLUDES', value: { items: [], excluded: [] } } }), {});

console.log('\n── special-value criteria');
check('phash_distance hoists distance',
  t({ phash_distance: { modifier: 'NOT_NULL', value: { distance: 4, value: 'abc' } } }),
  { phash_distance: { value: 'abc', distance: 4, modifier: 'NOT_NULL' } });
check('stash_id_endpoint renames stashID → stash_id',
  t({ stash_id_endpoint: { modifier: 'IS_NULL', value: { endpoint: '', stashID: 'xyz' } } }),
  { stash_id_endpoint: { endpoint: '', stash_id: 'xyz', modifier: 'IS_NULL' } });
check('orientation wraps a bare enum into a list (value is [OrientationEnum!]!)',
  t({ orientation: { value: 'LANDSCAPE' } }),
  { orientation: { value: ['LANDSCAPE'] } });
check('orientation leaves an existing list alone',
  t({ orientation: { value: ['LANDSCAPE'] } }),
  { orientation: { value: ['LANDSCAPE'] } });

console.log('\n── nullary modifiers get a valid operand');
check('text IS_NULL sends an empty string',
  t({ details: { modifier: 'IS_NULL', value: {} } }),
  { details: { value: '', modifier: 'IS_NULL' } });
check('int NOT_NULL sends zero',
  t({ duration: { modifier: 'NOT_NULL', value: {} } }),
  { duration: { value: 0, modifier: 'NOT_NULL' } });
check('enum IS_NULL sends its first member',
  t({ resolution: { modifier: 'IS_NULL', value: {} } }),
  { resolution: { value: ENUMS.ResolutionEnum[0], modifier: 'IS_NULL' } });
check('stash id IS_NULL sends an empty endpoint',
  t({ stash_id_endpoint: { modifier: 'IS_NULL', value: {} } }),
  { stash_id_endpoint: { endpoint: '', modifier: 'IS_NULL' } });
check('a stored stash-id operand is kept',
  t({ stash_id_endpoint: { modifier: 'IS_NULL', value: { endpoint: '/x', stashID: '9' } } }),
  { stash_id_endpoint: { endpoint: '/x', stash_id: '9', modifier: 'IS_NULL' } });
check('a blank value2 is omitted',
  t({ duration: { modifier: 'BETWEEN', value: { value: 60, value2: '' } } }),
  { duration: { value: 60, modifier: 'BETWEEN' } });

console.log('\n── nesting');
check('recurses into AND (object form)',
  t({ AND: { organized: { modifier: 'EQUALS', value: 'true' } } }),
  { AND: { organized: true } });
check('recurses into OR (list form)',
  t({ OR: [{ path: { modifier: 'INCLUDES', value: 'a' } }, { path: { modifier: 'INCLUDES', value: 'b' } }] }),
  { OR: [{ path: { value: 'a', modifier: 'INCLUDES' } }, { path: { value: 'b', modifier: 'INCLUDES' } }] });
check('recurses into performers_filter',
  t({ performers_filter: { name: { modifier: 'INCLUDES', value: 'Ann' } } }),
  { performers_filter: { name: { value: 'Ann', modifier: 'INCLUDES' } } });

console.log('\n── no-op and unknown handling');
check('drops an empty string criterion (INCLUDES "" would match everything)',
  t({ title: { modifier: 'INCLUDES', value: '' } }), {});
check('drops a quoted-empty criterion',
  t({ path: { modifier: 'INCLUDES', value: '""' } }), {});
check('keeps an empty value beside a nullary modifier',
  t({ stash_id_endpoint: { modifier: 'IS_NULL', value: { endpoint: '', stashID: '' } } }),
  { stash_id_endpoint: { endpoint: '', stash_id: '', modifier: 'IS_NULL' } });
check('passes an unknown field through untouched',
  t({ something_new: { modifier: 'EQUALS', value: 'x' } }),
  { something_new: { modifier: 'EQUALS', value: 'x' } });
check('drops nullish fields',
  t({ path: null, organized: undefined }), {});
check('null input → {}', t(null), {});
check('an unknown filter type is returned as-is',
  translateFilter({ a: 1 }, 'NopeFilterType'), { a: 1 });

console.log('\n── idempotency (a second pass must be a no-op)');
const TRICKY = {
  organized: { modifier: 'EQUALS', value: 'false' },
  path: { modifier: 'INCLUDES', value: '"/a b"' },
  tags: { modifier: 'INCLUDES', value: { depth: 0, excluded: [], items: [{ id: '7', label: 'x' }] } },
  performers: { modifier: 'INCLUDES_ALL', value: { items: [{ id: '9', label: 'y' }] } },
  phash_distance: { modifier: 'NOT_NULL', value: { distance: 4, value: 'abc' } },
  stash_id_endpoint: { modifier: 'IS_NULL', value: { endpoint: '', stashID: 'z' } },
  orientation: { value: 'LANDSCAPE' },
  play_duration: { modifier: 'LESS_THAN', value: { value: 1 } },
  AND: { has_markers: { modifier: 'INCLUDES', value: 'true' } },
  custom_fields: [{ field: 'f', value: 'v' }],
  unknown_thing: { modifier: 'EQUALS', value: 'q' },
};
const once = t(TRICKY);
const twice = t(once);
check('translate(translate(x)) === translate(x)', twice, once);
check('and a third pass too', t(twice), once);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
