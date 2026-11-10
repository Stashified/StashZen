/**
 * mockSort, the Test-mode ordering, shared by every mock listing.
 *
 * A sort *value* is Stash's vocabulary and a mock row's field names are the
 * app's. When they differ the comparator looks up a key no row has, every
 * comparison ties, and the sort control silently does nothing, in the one mode
 * a user opens to check that the controls work. `alias` maps the names each
 * service knows both of (`duration` → `durationSeconds`, `height` →
 * `height_cm`, `scenes_count` → `scene_count`).
 *
 * `random` is the second special case: a mock that reshuffled between pages
 * would drop and duplicate rows, so the order is stable, each id getting a
 * hash as rank. The seeded spelling hashes the seed with the id too, so a
 * reshuffle deals a new order and still pages stably.
 *
 * Numbers compare numerically and strings case-insensitively; a null or missing
 * value sorts low rather than throwing, because a mock row is as likely to be
 * missing a date as to have one.
 */

const RANKS = new Map();

/** FNV-1a, 32-bit, a stable, dependency-free rank for one key. */
function rankOf(text) {
  const key = String(text ?? '');
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
  const seeded = /^random_(\d+)$/.exec(String(sort ?? ''));

  if (seeded || key === 'random') {
    // Empty for plain `random`, so its order stays as it was.
    const prefix = seeded ? `${seeded[1]}:` : '';
    return (a, b) => {
      const d = rankOf(prefix + String(a?.id ?? '')) - rankOf(prefix + String(b?.id ?? ''));
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
