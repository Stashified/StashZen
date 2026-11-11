/**
 * useSentinelLoadMore: page when the end-of-list sentinel nears the viewport.
 *
 * Shared by every infinite grid so the lead is one number, not four. Three
 * rows of 1200px: the request plus forty covers takes a moment on the TV's
 * Wi-Fi, and asking when the sentinel is already visible is what puts
 * "Loading more…" on screen at every page edge.
 *
 * The effect runs once the refs hold nodes; on first render the grid still
 * shows its loading state, so the sentinel does not exist yet. Paging starts
 * because `loadMore`'s identity changes when that state clears. A caller that
 * passed a permanently stable callback would observe nothing.
 */

import { useEffect } from 'react';

export const SENTINEL_ROOT_MARGIN = '1200px 0px';

export function useSentinelLoadMore(sentinelRef, scrollRef, loadMore) {
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { root, rootMargin: SENTINEL_ROOT_MARGIN, threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinelRef, scrollRef, loadMore]);
}
