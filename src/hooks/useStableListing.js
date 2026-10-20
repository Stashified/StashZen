/**
 * useStableListing — a listing object whose identity does not change.
 *
 * VideoCard is memoised, and the listing it receives is only ever read from
 * an event handler: the rows, the total, the page and the fetch closure are
 * handed back up so a play queue can continue from the rows the user is
 * looking at. A plain `useMemo` keyed on `items` does not give the card a
 * stable prop — a page append replaces `items`, which is precisely the render
 * where every card was supposed to be skipped. The getters below always read
 * the latest values, so a handler sees current data while the object's
 * identity stays fixed.
 *
 * A layout effect rather than a render-phase write: it runs before paint and
 * therefore before any user event, so a handler can never observe a value
 * from a render React threw away.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';

export function useStableListing(values) {
  const ref = useRef(values);
  useLayoutEffect(() => { ref.current = values; });

  return useMemo(() => ({
    get items() { return ref.current.items; },
    get total() { return ref.current.total; },
    get page() { return ref.current.page; },
    get fetchPage() { return ref.current.fetchPage; },
  }), []);
}
