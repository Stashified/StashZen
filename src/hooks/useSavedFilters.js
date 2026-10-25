/**
 * useSavedFilters — fetch & expose the saved filters for a given Stash mode.
 *
 * Filters are empty in mock mode (Stash-only), and the fetch is cached in
 * filterService so tab switches do not re-hit the network.
 *
 * `source` and `revision` are separate because changes to them mean opposite
 * things: a new source invalidates every row on screen, while a revision bump
 * is a refresh of the same server's list, which must not blank it.
 */

import { useEffect, useRef, useState } from 'react';
import { fetchSavedFilters, clearSavedFiltersCache } from '../utils/filterService.js';

export function useSavedFilters(mode, source = '', revision = 0) {
  const [filters, setFilters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const lastScopeRef = useRef(null);

  useEffect(() => {
    if (!mode) {
      // Clear the in-flight state too: the cleanup has already cancelled its
      // promise, so nothing else would ever lower this flag.
      setFilters([]);
      setLoading(false);
      setError(null);
      lastScopeRef.current = null;
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    // A list fetched for the previous mode or *server* belongs to that one:
    // filter ids are namespaced by scene/image/gallery and name a row on one
    // instance. Keeping the old rows selectable while the new fetch is in
    // flight — or after it fails — would resolve the id against the wrong
    // list, or none, and silently run unfiltered.
    //
    // Not keyed on `revision`: that is bumped after a save, and blanking the
    // dropdown on every save-time refresh would flash the panel the user is
    // standing in. JSON rather than a joined string because the source is a
    // URL and no separator is guaranteed absent from one.
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