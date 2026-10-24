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
// The showroom shelves are the exception (`showroom-recent-scenes-video-…`):
// they are not paged listings and register no driver, so a restore that names
// one still succeeds through the registry lookup and simply skips `loadMore`.
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
  // The user outranks a restore. A card that only exists on page 4 can take
  // several seconds; without this, a D-pad press during the wait would move
  // the cursor and then be yanked back when the page landed (the review's
  // R2). The listener is added after Back's own keydown has finished
  // dispatching, so it never cancels the restore it was caused by.
  const onUserKey = () => settle();
  window.addEventListener('keydown', onUserKey, true);

  // One timer at a time. The old code ran a 50 ms poll chain *and* scheduled
  // an extra `attempt` after every settled page, so up to thirteen chains
  // overlapped near the deadline.
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
        // Only a fetch that actually started spends the budget (the review's
        // R3). `loadMore` resolves `false` when its guards turn it into a
        // no-op; counting those consumed all twelve pages in milliseconds and
        // then waited out the deadline.
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
