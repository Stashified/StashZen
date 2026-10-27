/**
 * updateCheck.js: the public build's release check.
 *
 * Only wired up when both `__UPDATE_CHECK__` and `__UPDATE_URL__` are set
 * (the public workflow does that). Everything here is pure apart from the
 * shared timeout wrapper, so every branch is testable offline.
 */

import { fetchWithTimeout, StashError } from './stashClient.js';

export const UPDATE_TIMEOUT_MS = 8000;
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Off the boot path: a TV that just woke should paint before it uses the
// network, and an update is never urgent.
export const UPDATE_AUTO_DELAY_MS = 3000;

/**
 * The numeric segments of a release tag, or null.
 *
 * GitHub serves `v0.37.2`. A prerelease suffix is ignored because
 * `/releases/latest` excludes prereleases anyway; requiring 2 to 4 numeric
 * segments rejects a tag like `latest`.
 */
export function parseVersionTag(tagName) {
  const m = /^[vV]?(\d+(?:\.\d+){1,3})(?:[-+].*)?$/.exec(
    String(tagName ?? '').trim(),
  );
  return m ? m[1].split('.').map(Number) : null;
}

/** 1 if a > b, -1 if a < b, 0 if equal, null if either side is unreadable. */
export function compareVersions(a, b) {
  const left = parseVersionTag(a);
  const right = parseVersionTag(b);
  if (!left || !right) return null;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

/**
 * Whether an automatic check is due. A timestamp in the future counts as due
 * rather than locking checks out until the TV's clock catches up; the write
 * after the attempt repairs it.
 */
export function isUpdateCheckDue(
  lastAt, now = Date.now(), intervalMs = UPDATE_INTERVAL_MS,
) {
  if (!Number.isFinite(lastAt) || lastAt <= 0) return true;
  const elapsed = now - lastAt;
  return elapsed < 0 || elapsed >= intervalMs;
}

export function updateCheckArmed() {
  // Both locks: an armed flag without a URL still does nothing. `typeof` keeps
  // a build config that forgets the defines from throwing at render time.
  return typeof __UPDATE_CHECK__ !== 'undefined' && !!__UPDATE_CHECK__
    && typeof __UPDATE_URL__ !== 'undefined' && !!__UPDATE_URL__;
}

/**
 * Read the latest release's tag. `fetchImpl` is injectable so the tests can
 * assert the request shape and every failure without a network.
 *
 * No Authorization header, no credentials, nothing device-specific: this is a
 * public endpoint and the request discloses only that the app ran.
 */
export async function fetchLatestRelease({
  url,
  timeoutMs = UPDATE_TIMEOUT_MS,
  fetchImpl = fetchWithTimeout,
}) {
  if (!url) return { ok: false, reason: 'unconfigured' };

  try {
    const body = await fetchImpl(
      url,
      { method: 'GET', headers: { Accept: 'application/vnd.github+json' } },
      timeoutMs,
      async (res) => {
        if (!res.ok) {
          throw new StashError(`GitHub returned HTTP ${res.status}.`, 'http', res.status);
        }
        try {
          return await res.json();
        } catch {
          throw new StashError('Unexpected response from GitHub.', 'parse');
        }
      },
    );
    const parts = parseVersionTag(body?.tag_name);
    if (!parts) return { ok: false, reason: 'tag' };
    return { ok: true, latestVersion: parts.join('.') };
  } catch (e) {
    const reason = e?.code === 'timeout' ? 'timeout'
      : e?.code === 'http' ? 'http'
        : e?.code === 'parse' ? 'parse' : 'network';
    return { ok: false, reason, status: e?.status };
  }
}
