/**
 * useAutoUpdateCheck: the one owner of the release check.
 *
 * `checkOnce` sits at module scope so an automatic check and a manual press
 * share one request: pressing Check now while the boot check is in flight must
 * not spend a second call. The settings write is one patch, so subscribers get
 * one notify per completed check.
 *
 * The automatic check is opt-in and runs at most once per interval. The
 * timestamp is written on failure too, so an offline TV does not retry on every
 * launch; the manual button always works.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { setSettings } from '../utils/settings.js';
import {
  fetchLatestRelease, isNewerVersion, isUpdateCheckDue, updateCheckArmed,
  UPDATE_AUTO_DELAY_MS,
} from '../utils/updateCheck.js';

let inFlight = null;

function failureText(result) {
  switch (result?.reason) {
    case 'timeout': return 'The check timed out.';
    case 'http': return 'GitHub returned an error.';
    case 'parse':
    case 'tag': return 'The release information was unreadable.';
    case 'unconfigured': return '';
    default: return 'No network connection.';
  }
}

function checkOnce() {
  if (!updateCheckArmed()) return Promise.resolve({ ok: false, reason: 'unconfigured' });
  if (inFlight) return inFlight;

  inFlight = fetchLatestRelease({ url: __UPDATE_URL__ })
    .then((result) => {
      const patch = { lastUpdateCheckAt: Date.now() };
      if (result.ok) patch.updateLatestVersion = result.latestVersion;
      setSettings(patch);
      return result;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function useAutoUpdateCheck(settings) {
  const enabled = !!settings.updateCheckEnabled;
  const lastAt = settings.lastUpdateCheckAt;
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const checkNow = useCallback(async () => {
    if (!updateCheckArmed()) return null;
    setPhase('checking');
    setError('');
    const result = await checkOnce();
    if (!aliveRef.current) return result;
    if (result.ok) {
      setPhase('idle');
      setError('');
    } else {
      setPhase('error');
      setError(failureText(result));
    }
    return result;
  }, []);

  useEffect(() => {
    if (!updateCheckArmed() || !enabled) return undefined;
    // The timestamp is a dependency: the write after a check makes this false
    // on the next pass, so the timer is not re-armed for 24 h.
    if (!isUpdateCheckDue(lastAt)) return undefined;
    const t = setTimeout(() => { checkNow(); }, UPDATE_AUTO_DELAY_MS);
    return () => clearTimeout(t);
  }, [enabled, lastAt, checkNow]);

  const availableVersion = updateCheckArmed()
    && isNewerVersion(settings.updateLatestVersion, __APP_VERSION__)
    ? settings.updateLatestVersion
    : '';

  return { phase, error, checkNow, availableVersion };
}
