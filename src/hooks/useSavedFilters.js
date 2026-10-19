/**
 * useSavedFilters — fetch & expose saved filters for a given Stash mode.
 *
 * Returns { filters, loading, error }. Filters list is empty in mock
 * mode (Stash-only feature). The fetch is cached in filterService, so
 * tab-switches don't re-hit the network.
 *
 * `source` identifies the data source (App.jsx passes its `dataKey`), and
 * `revision` is the app's own "ask again" counter, bumped after a save.
 * They are separate because a change to them means opposite things: a new
 * source invalidates every row on screen, and a revision bump is a refresh
 * of the same server's list, which must not blank it.
 */

import { useEffect, useRef, useState } from 'react';
import { fetchSavedFilters, clearSavedFiltersCache } from '../utils/filterService.js';

export function useSavedFilters(mode, source = '', revision = 0) {
  const [filters, setFilters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const lastScopeRef = useRef(null);

  useEffect(() => {
    if (!mode) { setFilters([]); lastScopeRef.current = null; return; }

    let cancelled = false;
    setLoading(true);
    setError(null);
    // A list fetched for the previous mode or the previous *server* belongs
    // to that one: filter ids are namespaced by scene/image/gallery, and a
    // saved id names a row on one Stash instance. Keeping the old rows
    // selectable while the new fetch is in flight — or after it fails — is
    // the trap: the id resolves against the wrong list, or against none, and
    // the listing silently runs unfiltered. A change to either clears the
    // list immediately and lets the empty state own the gap.
    //
    // Not keyed on `revision`: that is bumped after a save, and blanking the
    // dropdown on every save-time refresh would flash the panel the user is
    // standing in.
    // JSON rather than a joined string: the source is a URL, and no
    // separator is guaranteed absent from one.
    const scope = JSON.stringify([source, mode]);
    if (lastScopeRef.current !== scope) {
      lastScopeRef.current = scope;
      setFilters([]);
    }

    fetchSavedFilters(mode, source)
      .then(list => {
        if (cancelled) return;
        setFilters(list);
        setLoading(false);
      })
      .catch(e => {
        if (cancelled) return;
        setError(e.message);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [mode, source, revision]);

  return { filters, loading, error };
}

// Re-export for callers that want to invalidate the cache directly.
export { clearSavedFiltersCache };