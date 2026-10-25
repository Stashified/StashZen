/**
 * useStableListing — a listing object whose identity never changes, for the
 * memoised VideoCard. A `useMemo` keyed on `items` breaks on every page
 * append; the getters instead read the latest values, so a handler sees
 * current data at a fixed identity. A layout effect updates them before paint
 * and thus before any user event, so a handler never observes a value from a
 * render React threw away.
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
