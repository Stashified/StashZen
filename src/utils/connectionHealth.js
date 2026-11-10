/**
 * connectionHealth: one shared answer to "can the Stash server be reached".
 *
 * Every Stash request goes through `runQuery`, so that is the only place a
 * result is noted. Only an unreachable server counts: a timeout or a network
 * failure. HTTP and GraphQL errors are *answers*, and a rejected API key or a
 * bad query must not be reported as a connection problem.
 *
 * One success clears the state. That is what lets the banner's Retry recover
 * without restarting the app.
 */

const UNREACHABLE = new Set(['network', 'timeout']);

const CLEAR = { down: false, message: '' };
let state = CLEAR;
const listeners = new Set();
// Bumped when the source changes. A request from the old one carries the old
// number, so its late answer cannot speak for the new one.
let generation = 0;

function emit(next) {
  if (next.down === state.down && next.message === state.message) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Note the outcome of one request. `error` is null on success.
 *
 * An aborted request is the app cancelling its own fetch (a tab change, an
 * unmount), not the server failing; see `fetchWithTimeout`.
 */
export function noteQueryResult(error, gen = generation) {
  if (gen !== generation) return;
  if (!error) {
    emit(CLEAR);
    return;
  }
  if (error.name === 'AbortError') return;
  if (!UNREACHABLE.has(error.code)) return;
  emit({ down: true, message: error.message });
}

export function getConnectionState() {
  return state;
}

export function subscribeConnection(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The generation a request is answered for; read when the request starts. */
export function getConnectionGeneration() {
  return generation;
}

/**
 * The endpoint or Test mode changed: every answer already in flight belongs to
 * the old source, and its verdict no longer applies. The settings store calls
 * this, before React renders, so the new source's first request sees the new
 * generation and starts from a clean state.
 */
export function noteSourceChanged() {
  generation += 1;
  emit(CLEAR);
}
