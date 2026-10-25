import { registry } from '../hooks/useFocusable.js';
import { beginRestore, endRestore } from './restorePending.js';

/** Focus a card by id, waiting for it to exist.
 *
 * Back out of a filtered listing crosses a tab switch that unmounts the grid,
 * and the listing may still be fetching — so the element does not exist when
 * the tab returns. Retried rather than deferred by a guessed interval, because
 * the guess is a race.
 *
 * `document.contains` matters: unmounted cards can remain in the registry,
 * pointing at a detached node `.focus()` silently ignores.
 *
 * **A remounted listing only holds page 1** (listings page 40 at a time), so a
 * card from page 3 needs paging. Listings register a driver
 * (`registerFocusListing`); the restore asks the owning listing for one more
 * page at a time and focuses the card as it lands — the position is the card,
 * not the page number.
 *
 * Bounds: 8 s and 12 extra pages, so a deleted card cannot walk a 10 000-row
 * listing to the end. At either bound the cursor stays where autofocus put it;
 * `fallback` gives a caller a better answer (the player uses the origin card).
 */

// prefix → { loadMore, canLoad, pending? }, registered by `usePagedList`. It
// comes from the mounted listing, which unregisters in its effect cleanup, so
// the lookup can never drive a grid that is not on screen.
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

// Short enough that landing feels like one movement, not a first card then a
// jump: an attempt is a Map lookup plus `document.contains`.
const RETRY_MS = 50;
const MAX_RESTORE_MS = 8000;
const MAX_EXTRA_PAGES = 12;

// Cards are `<prefix>-<id>`; prefixes contain no dash. Showroom shelves
// (`showroom-recent-scenes-video-…`) are not paged listings and register no
// driver, so a restore naming one still lands via the registry, skipping
// `loadMore`.
const prefixOf = (id) => {
  const at = String(id).indexOf('-');
  return at > 0 ? String(id).slice(0, at) : null;
};

/** Focus the first control in the content area.
 *
 * The closing fallback for an overlay whose remembered element has gone. It is
 * better than leaving the cursor on <body>, where there is no zone for the
 * D-pad to move from.
 */
export function focusFirstControl() {
  const first = document.querySelector('[role="main"] [tabindex="0"]:not([disabled])');
  if (first) first.focus();
}

export function focusByIdWhenReady(id, { fallback } = {}) {
  if (!id) return;
  const prefix = prefixOf(id);
  const deadline = Date.now() + MAX_RESTORE_MS;
  let pages = 0;
  let settled = false;
  let timer = null;

  // Tell the listings to hold their first-card auto-focus until this lands.
  beginRestore();

  const clearTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimer();
    window.removeEventListener('keydown', onUserKey, true);
    endRestore();
  };
  // The user outranks a restore: a page-4 card can take seconds, and without
  // this a D-pad press during the wait would be yanked back when it lands. The
  // listener is added after Back's keydown has dispatched, so it never cancels
  // the restore it caused.
  const onUserKey = () => settle();
  window.addEventListener('keydown', onUserKey, true);

  // One timer at a time; overlapping poll chains would pile up near the
  // deadline.
  const schedule = (ms) => {
    clearTimer();
    timer = setTimeout(attempt, ms);
  };

  function attempt() {
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
    if (!driver || driver.pending || pages >= MAX_EXTRA_PAGES || !driver.canLoad?.()) {
      schedule(RETRY_MS);
      return;
    }

    // The flag lives on the shared driver, not in this closure: two restores
    // can be in flight (a Back pressed twice), and they must not fetch the
    // same page twice.
    driver.pending = true;
    Promise.resolve(driver.loadMore?.())
      .then((started) => {
        driver.pending = false;
        if (settled) return;
        // Only a fetch that actually started spends the budget: `loadMore`
        // resolves `false` when its guards make it a no-op, and counting those
        // used all twelve pages in milliseconds.
        if (started) pages += 1;
        // A started page gets looked at immediately after React commits it;
        // a no-op waits for the ordinary poll.
        schedule(started ? 0 : RETRY_MS);
      })
      .catch(() => {
        driver.pending = false;
        if (!settled) schedule(RETRY_MS);
      });
  }

  attempt();
}
