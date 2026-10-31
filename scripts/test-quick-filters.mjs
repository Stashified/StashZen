#!/usr/bin/env node
/**
 * test-quick-filters.mjs: chips folding into the listing's filter
 *
 *   node scripts/test-quick-filters.mjs
 *
 * The shape matters more than the criteria: a chip beside a base filter must
 * nest (`{AND: {AND: base, chip}}`) or a saved filter's own rating range is
 * replaced by the chip's, and an untouched row must return the base object
 * itself, or every listing remounts on each render.
 */

import { QUICK_FILTERS, quickFilterCriterion, combineQuickFilters } from '../src/utils/quickFilters.js';

let failed = 0;
let passed = 0;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(label, pass, detail = '') {
  if (pass) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`);
  }
}

const scenes = QUICK_FILTERS.scenes;
const base = { tags: { value: ['7'], modifier: 'INCLUDES' } };

const none = combineQuickFilters(base, scenes, []);
check('no chips returns the base object', none === base);

const unknown = combineQuickFilters(base, scenes, ['nope']);
check('an unknown chip id is ignored', unknown === base);

const one = combineQuickFilters(null, scenes, ['unwatched']);
check('one chip on no base is the criterion itself',
  eq(one, { play_count: { value: 0, modifier: 'EQUALS' } }), JSON.stringify(one));

const both = combineQuickFilters(null, scenes, ['unwatched', 'markers']);
check('chips on no base merge at the top level',
  eq(both, { play_count: { value: 0, modifier: 'EQUALS' }, has_markers: 'true' }),
  JSON.stringify(both));

const folded = combineQuickFilters(base, scenes, ['rated4']);
check('a chip beside a base nests the base',
  eq(folded, {
    AND: {
      AND: base,
      rating100: { value: 39, modifier: 'GREATER_THAN' },
    },
  }), JSON.stringify(folded));

const empty = combineQuickFilters({}, scenes, ['markers']);
check('an empty base does not add a nesting level',
  eq(empty, { has_markers: 'true' }), JSON.stringify(empty));

const now = new Date(2026, 6, 15).getTime();
const year = quickFilterCriterion('addedThisYear', now);
const start = Math.floor(new Date(2026, 0, 1).getTime() / 1000);
check('addedThisYear starts at January 1 as a String',
  eq(year, { created_at: { value: String(start), modifier: 'GREATER_THAN' } }),
  JSON.stringify(year));

check('galleries carry no scene-only chip',
  !QUICK_FILTERS.galleries.some(d => d.id === 'unwatched' || d.id === 'markers'));

// Stash spells the performer favourite flag `filter_favorites`, while the tag
// and studio filter types use `favorite`; getting the pair backwards is a
// server-side validation error, not a wrong result.
check('performers use filter_favorites',
  eq(quickFilterCriterion('filterFavorites'), { filter_favorites: true }));
check('tags and studios use favorite',
  eq(quickFilterCriterion('favorite'), { favorite: true }));
check('tags offer no rating chip',
  !QUICK_FILTERS.tags.some(d => d.id === 'rated4'));
check('a quick-filter id absent from its tab is ignored',
  combineQuickFilters(base, QUICK_FILTERS.tags, ['rated4']) === base);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
