/**
 * The mock data paths resolve after a delay instead of aborting like fetch, so
 * they must reject the same way: callers treat `AbortError` as "closed, not
 * failed", and a plain resolve would paint a page nobody asked for.
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}
