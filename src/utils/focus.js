import { registry } from '../hooks/useFocusable.js';

/** Focus a card by id, waiting for it to exist.
 *
 * Needed because "Back out of a filtered listing returns you where you were"
 * crosses a tab switch, which unmounts the grid the card lived in and remounts
 * it on the way back. The element therefore does not exist at the moment the
 * tab is restored — and the listing behind it may still be fetching. Retried
 * rather than deferred by a guessed interval, because the guess is a race and
 * this is one function.
 *
 * `document.contains` is not paranoia: the registry is keyed by id and a card
 * that unmounted may still be in it, in which case the entry points at a
 * detached node that `.focus()` would silently ignore.
 *
 * **What it cannot do**: reach a card the grid has not loaded yet. The listings
 * page 40 at a time, so returning to a section for something past row 40 leaves
 * focus on the first card instead. Reaching it would mean driving that grid's
 * `fetchPage` until the id appeared, which is a feature rather than a retry
 * budget — and the fallback is the top of the listing, which is a place the
 * user recognises. */
export function focusByIdWhenReady(id, tries = 25) {
  if (!id) return;
  const attempt = (n) => {
    const el = registry.get(id)?.el;
    if (el && document.contains(el)) { el.focus(); return; }
    if (n > 0) setTimeout(() => attempt(n - 1), 120);
  };
  attempt(tries);
}
