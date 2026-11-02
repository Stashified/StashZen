/**
 * syncChip: the save-status chip's state, as a tiny external store.
 *
 * It is not React state because the only thing that draws it is one span in the
 * time row, while the writes happen on the save timer: as state it re-rendered
 * the whole player, rail and overlays included, twice per save cycle. The time
 * row subscribes on its own and the rest of the player never hears about it.
 *
 * `saved` clears itself after two seconds: a status that never goes away reads
 * as a label.
 */

const SAVED_VISIBLE_MS = 2000;

export function createSyncChip() {
  let state = 'idle';
  let error = null;
  let idleTimer = null;
  const listeners = new Set();

  const emit = () => { for (const fn of listeners) fn(); };

  function set(next, err = null) {
    // The error belongs to the failed state only; a successful save clears it
    // so a stale message cannot survive on a later chip.
    if (next === 'failed') error = err;
    else if (next === 'saved') error = null;
    state = next;

    clearTimeout(idleTimer);
    if (next === 'saved') {
      idleTimer = setTimeout(() => {
        state = 'idle';
        emit();
      }, SAVED_VISIBLE_MS);
    }
    emit();
  }

  return {
    set,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState: () => state,
    getError: () => error,
    dispose() {
      clearTimeout(idleTimer);
      listeners.clear();
    },
  };
}
