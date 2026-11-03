/**
 * useServerVersion: the Stash version behind the current data source.
 *
 * One `{ version { version } }` request per source, cached by `dataKey` so
 * switching tabs or remounting a page does not ask again. Test mode reports the
 * newest known version so capability-gated UI is still exercised off-device.
 */

import { useEffect, useState } from 'react';
import { dataSourceKey, getSettings } from '../utils/settings.js';
import { setServerVersion } from '../utils/serverInfo.js';
import { runQuery } from '../utils/stashQuery.js';

const MOCK_VERSION = '0.32.0';
const cache = new Map(); // dataKey → Promise<string|null>

const RETRY_MS = 800;

async function askVersion() {
  const data = await runQuery('{ version { version } }');
  const raw = data?.version?.version;
  return raw ? String(raw).replace(/^v/i, '') : null;
}

function loadVersion(dataKey) {
  if (cache.has(dataKey)) return cache.get(dataKey);
  const pending = (async () => {
    if (getSettings().useMock) return MOCK_VERSION;
    const first = await askVersion().catch(() => null);
    if (first) return first;
    // One retry: a single dropped request would otherwise hide every gated
    // control until the app restarts, and the version cannot change mid-session.
    await new Promise(r => setTimeout(r, RETRY_MS));
    // The source can change inside the retry window, and that answer would
    // belong to the new server. Do not cache it under the old key.
    if (dataSourceKey(getSettings()) !== dataKey) return null;
    return askVersion().catch(() => null);
  })().then(version => {
    if (!version) cache.delete(dataKey);
    return version;
  });
  cache.set(dataKey, pending);
  return pending;
}

export function clearServerVersionCache() {
  cache.clear();
  setServerVersion(null);
}

export function useServerVersion(dataKey) {
  const [version, setVersion] = useState(null);
  const [versionFor, setVersionFor] = useState(null);

  // Render-phase reset, matching the source-change pattern elsewhere: a child
  // effect can fetch before App's effect runs, so the shared store must not
  // still name the previous source's server.
  if (versionFor !== dataKey) {
    setVersionFor(dataKey);
    setServerVersion(null);
    if (version !== null) setVersion(null);
  }

  useEffect(() => {
    let live = true;
    loadVersion(dataKey).then(v => {
      if (!live) return;
      setServerVersion(v);
      setVersion(v);
    });
    return () => { live = false; };
  }, [dataKey]);

  return version;
}
