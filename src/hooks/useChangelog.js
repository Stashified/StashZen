/**
 * useChangelog: the viewer's data source.
 *
 * The changelog is read only when the panel opens, so launch stays free of an
 * extra request. A module cache with a short TTL makes reopening instant and
 * keeps a failed refresh from blanking notes that were already on screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHANGELOG_CACHE_TTL_MS, changelogArmed, changelogFailureText, fetchChangelog,
} from '../utils/changelog.js';

let cache = null;      // { releases, at }
let inFlight = null;

function load() {
  if (inFlight) return inFlight;
  inFlight = fetchChangelog({ url: __CHANGELOG_URL__ })
    .then((result) => {
      if (result.ok) cache = { releases: result.releases, at: Date.now() };
      return result;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Test seam: the harness remounts one bundle and needs a cold cache. */
export function clearChangelogCache() {
  cache = null;
  inFlight = null;
}

export function useChangelog() {
  const [state, setState] = useState(() => {
    if (!changelogArmed()) return { status: 'idle', releases: [], error: '' };
    if (cache) return { status: 'ready', releases: cache.releases, error: '' };
    return { status: 'loading', releases: [], error: '' };
  });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!changelogArmed()) return undefined;
    // A fresh cache is enough; a stale one paints at once and refreshes below.
    if (cache && Date.now() - cache.at < CHANGELOG_CACHE_TTL_MS) {
      setState({ status: 'ready', releases: cache.releases, error: '' });
      return undefined;
    }

    let alive = true;
    if (!cache) setState({ status: 'loading', releases: [], error: '' });
    load().then((result) => {
      if (!alive) return;
      if (result.ok) {
        setState({ status: 'ready', releases: result.releases, error: '' });
      } else if (!cache) {
        setState({
          status: 'error', releases: [], error: changelogFailureText(result.reason),
        });
      }
      // A failed refresh keeps the stale notes that are already on screen.
    });
    return () => { alive = false; };
  }, []);

  const reload = useCallback(async () => {
    if (!changelogArmed()) return;
    setState(prev => ({
      status: prev.releases.length ? 'ready' : 'loading',
      releases: prev.releases,
      error: '',
    }));
    const result = await load();
    if (!aliveRef.current) return;
    if (result.ok) {
      setState({ status: 'ready', releases: result.releases, error: '' });
    } else if (!cache) {
      setState({
        status: 'error', releases: [], error: changelogFailureText(result.reason),
      });
    }
  }, []);

  return { ...state, reload };
}
