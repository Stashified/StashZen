/**
 * randomSort — make Stash's `random` sort page-stable.
 *
 * Stash reads `sort: "random"` as "shuffle the result set for this request".
 * Two requests with the same filter therefore return two different orders,
 * so page 2 overlaps page 1, the client dedupes the repeats, and under the
 * no-progress stop a short result set can end early (the review's R8).
 *
 * Stash also accepts `random_<seed>`, which permutes once per seed and
 * returns the same order on every page (verified against the live server:
 * `random_123` repeats page 1 exactly and continues the same permutation on
 * page 2). The seed below is derived from the request identity — the entity
 * kind, filter and search text — so every page of one listing shares a
 * permutation, and changing the filter or the search starts a new one.
 *
 * The mock comparator does not know the seeded spelling; `baseSort` maps it
 * back so Test mode keeps shuffling by id as it always did.
 */

const SEEDED = /^random_\d+$/;

/** FNV-1a, 32-bit. Deterministic and dependency-free. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The sort value to send to Stash. Anything but plain `random` passes
 * through untouched; `identity` is the parts that define this listing's
 * request (kind, filter, search), not the page number.
 */
export function stableSort(sort, ...identity) {
  if (sort !== 'random') return sort;
  // Keep the seed in the positive 31-bit range: it is a number in Stash's
  // sort grammar, and 0 is a perfectly valid seed but reads like a bug.
  const seed = (hash(JSON.stringify(identity)) % 2147483646) + 1;
  return `random_${seed}`;
}

/** The UI/mock spelling of a possibly seeded sort. */
export function baseSort(sort) {
  return SEEDED.test(String(sort || '')) ? 'random' : sort;
}
