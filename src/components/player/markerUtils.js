/**
 * The tag to offer first in the add-marker form: whichever tag this scene's own
 * markers use most.
 *
 * Not "the most recently used one", even though that is the intuition, because
 * the markers arrive without timestamps — and not the server's most-used tag
 * either, because a scene's own history is a far better predictor of the next
 * marker on it than the library as a whole is.
 *
 * Ties go to the tag that appears earliest in the scene, since the position is
 * only replaced on a strictly greater count. That makes the answer stable
 * across re-renders rather than dependent on iteration order.
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
 * The union is what makes a marker survive the request that raced it: the
 * player asks for a scene's markers as it opens, and one created while that
 * request is in flight comes back in neither the old state nor the response.
 * The per-scene reset means a marker in state can only belong to the scene
 * being fetched, so there is nothing stale for this to preserve.
 */
export function mergeMarkers(a, b) {
  const byId = new Map();
  for (const m of a) byId.set(m.id, m);
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.seconds - y.seconds);
}
