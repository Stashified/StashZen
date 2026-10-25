/**
 * The tag to offer first in the add-marker form: whichever tag this scene's own
 * markers use most. Not most-recently-used (markers arrive without timestamps)
 * and not the library's most-used — the scene's own history predicts better.
 *
 * Ties go to the earliest tag, since a position is replaced only on a strictly
 * greater count; that keeps the answer stable rather than iteration-dependent.
 */
export function deriveDefaultTag(markers) {
  const counts = new Map();
  let best = null;
  for (const m of markers) {
    const tag = m.primaryTag;
    if (!tag?.id) continue;
    const n = (counts.get(tag.id) || 0) + 1;
    counts.set(tag.id, n);
    if (!best || n > best.count) best = { count: n, tag };
  }
  return best?.tag || null;
}

/**
 * Union two marker lists by id, in playback order.
 *
 * A marker created while the open request is in flight appears in neither the
 * old state nor the response. The per-scene reset means state holds only this
 * scene's markers, so there is nothing stale to preserve.
 */
export function mergeMarkers(a, b) {
  const byId = new Map();
  for (const m of a) byId.set(m.id, m);
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.seconds - y.seconds);
}
