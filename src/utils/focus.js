import { registry } from '../hooks/useFocusable.js';
import { beginRestore, endRestore } from './restorePending.js';

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
 * **A remounted listing only holds its first page.** The listings page 40 at a
 * time, and the arriving grid fetches page 1 — so a card the user had scrolled
 * to on page 3 does not exist and no amount of waiting makes it appear. That
 * is why listings can be registered here (see `registerFocusListing`): while a
 * restore is searching, it asks the listing that owns the id for one more
 * page at a time, and focuses the card as soon as it lands. The user's
 * position is the card, not the page number — paging forward to it and
 * letting `scrollIntoView` bring it into view is the same place they left.
 *
 * Two bounds keep that honest: 8 s overall (a TV's real answer for a large
 * page, where the old 3 s budget gave up and left the first card focused), and
 * at most 12 extra pages, so a card that no longer exists cannot walk a
 * 10 000-row listing down to the end. If either bound is reached the search
 * leaves the cursor wherever the listing's own autofocus put it — the top of
 * the origin section, which is a place the user recognises. A caller that has
 * a better answer than that can pass `fallback` (the player uses it to fall
 * back to the card the playback was opened from).
 */

// prefix → { loadMore: () => unknown, canLoad: () => boolean, pending?: boolean }
//
// Registered by `usePagedList` for the sections that can be an origin. The
// object comes from the mounted listing, so the lookup can never drive a grid
// that is not on screen: an unmounted grid unregisters in its effect cleanup.
const listings = new Map();

/** Let `focusByIdWhenReady` page this listing forward while it looks for a
 *  card. `prefix` is the card id prefix ('tag', 'gallery', 'performer', …);
 *  the returned function unregisters the listing. */
export function registerFocusListing(prefix, driver) {
  listings.set(prefix, driver);
  return () => {
    if (listings.get(prefix) === driver) listings.delete(prefix);
  };
}

// Short enough that landing feels like one movement rather than a first card
// followed by a jump: each attempt is a Map lookup plus `document.contains`,
// so a fast poll costs nothing. The 8 s budget is unchanged.
const RETRY_MS = 50;
const MAX_RESTORE_MS = 8000;
const MAX_EXTRA_PAGES = 12;

// Cards are `<prefix>-<id>`, and the prefixes in use contain no dash.
const prefixOf = (id) => {
  const at = String(id).indexOf('-');
  return at > 0 ? String(id).slice(0, at) : null;
};

export function focusByIdWhenReady(id, { fallback } = {}) {
  if (!id) return;
  const prefix = prefixOf(id);
  const deadline = Date.now() + MAX_RESTORE_MS;
  let pages = 0;
  let settled = false;

  // Tell the listings to hold their first-card auto-focus until this lands.
  beginRestore();
  const settle = () => {
    if (settled) return;
    settled = true;
    endRestore();
  };

  const attempt = () => {
    if (settled) return;
    const el = registry.get(id)?.el;
    if (el && document.contains(el)) {
      settle();
      el.focus();
      return;
    }
    if (Date.now() > deadline) {
      settle();
      fallback?.();
      return;
    }

    const driver = prefix ? listings.get(prefix) : null;
    if (driver && !driver.pending && pages < MAX_EXTRA_PAGES && driver.canLoad?.()) {
      pages += 1;
      // The flag lives on the shared driver, not in this closure: two restores
      // can be in flight (a Back pressed twice), and they must not fetch the
      // same page twice.
      driver.pending = true;
      Promise.resolve(driver.loadMore?.())
        .finally(() => {
          driver.pending = false;
          // Look again as soon as the page has settled instead of waiting out
          // a timer tick — each page is a round trip already, and a restore
          // several pages deep would otherwise pay the poll interval per page.
          // Deferred by a task so React has committed the new rows.
          if (!settled) setTimeout(attempt, 0);
        });
    }
    setTimeout(attempt, RETRY_MS);
  };
  attempt();
}
