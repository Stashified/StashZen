/**
 * rowPatches: tell a mounted listing which of its rows a write changed.
 *
 * Dropping the page caches makes the next fetch fresh, but the grid already
 * holds its rows: a rating or a cleared resume point stays on the card until a
 * tab switch. Patches are scoped by entity because every listing numbers its
 * ids from one sequence, so a scene patch must not hit a performer with the
 * same id.
 */

const listeners = new Map();

/** Subscribe to patches for one entity. Returns the unsubscribe function. */
export function onRowPatch(entity, fn) {
  if (!listeners.has(entity)) listeners.set(entity, new Set());
  listeners.get(entity).add(fn);
  return () => { listeners.get(entity)?.delete(fn); };
}

/** Announce the fields a write changed, for rows of this entity. */
export function publishRowPatch(entity, id, patch) {
  if (id == null) return;
  for (const fn of listeners.get(entity) || []) fn(String(id), patch);
}
