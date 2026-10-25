/**
 * mockSort — the Test-mode ordering, shared by every mock listing.
 *
 * A sort *value* is Stash's vocabulary and a mock row's field names are the
 * app's. When they differ the comparator looks up a key no row has, every
 * comparison ties, and the sort control silently does nothing — in the one mode
 * a user opens to check that the controls work. `alias` maps the names each
 * service knows both of (`duration` → `durationSeconds`, `height` →
 * `height_cm`, `scenes_count` → `scene_count`).
 *
 * `random` is the second special case: the server reshuffles per request, but a
 * mock that reshuffled between pages would page through a list that drops and
 * duplicates rows — the order must be stable, so each id gets a hash as rank.
 *
 * Numbers compare numerically and strings case-insensitively; a null or missing
 * value sorts low rather than throwing, because a mock row is as likely to be
 * missing a date as to have one.
 */

const RANKS = new Map();

/** FNV-1a, 32-bit — a stable, dependency-free rank for one id. */
function rankOf(id) {
  const key = String(id ?? '');
  let rank = RANKS.get(key);
  if (rank === undefined) {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    rank = h >>> 0;
    RANKS.set(key, rank);
  }
  return rank;
}

export function mockComparator(sort, order, alias) {
  const descending = order !== 'asc';
  const key = (alias && alias[sort]) || sort;

  if (key === 'random') {
    return (a, b) => {
      const d = rankOf(a?.id) - rankOf(b?.id);
      return d === 0 ? 0 : (descending ? -d : d);
    };
  }

  return (a, b) => {
    let av = a?.[key];
    let bv = b?.[key];
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return descending ? 1 : -1;
    if (av > bv) return descending ? -1 : 1;
    return 0;
  };
}
