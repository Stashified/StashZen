#!/usr/bin/env node
/**
 * Tests for src/utils/updateCheck.js.
 *
 * Pure logic plus fetchLatestRelease with an injected transport. The injected
 * function has the same shape as fetchWithTimeout (url, options, timeoutMs,
 * consume), so the assertions cover what the real request would send: the
 * timeout, the Accept header and the absence of any credential.
 */

import {
  parseVersionTag, compareVersions, isNewerVersion, isUpdateCheckDue,
  fetchLatestRelease, UPDATE_INTERVAL_MS, UPDATE_TIMEOUT_MS,
} from '../src/utils/updateCheck.js';
import { StashError } from '../src/utils/stashClient.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const HOUR = 60 * 60 * 1000;

// ── parseVersionTag ─────────────────────────────────────
eq('parse: v-prefixed release tag', parseVersionTag('v0.37.2'), [0, 37, 2]);
eq('parse: bare tag', parseVersionTag('0.37.1'), [0, 37, 1]);
eq('parse: whitespace is trimmed', parseVersionTag('  v1.2.3 \n'), [1, 2, 3]);
eq('parse: four segments', parseVersionTag('v1.2.3.4'), [1, 2, 3, 4]);
eq('parse: two segments', parseVersionTag('v1.2'), [1, 2]);
eq('parse: prerelease suffix is ignored', parseVersionTag('v1.2.3-beta.1'), [1, 2, 3]);
eq('parse: build suffix is ignored', parseVersionTag('v1.2.3+abc'), [1, 2, 3]);
eq('parse: a word is not a version', parseVersionTag('nightly'), null);
eq('parse: a prefix word is not a version', parseVersionTag('release-1.2.3'), null);
eq('parse: a non-numeric segment is rejected', parseVersionTag('v1.2.x'), null);
eq('parse: an empty segment is rejected', parseVersionTag('v1..2'), null);
eq('parse: one segment is rejected', parseVersionTag('v1'), null);
eq('parse: empty and missing are rejected', [parseVersionTag(''), parseVersionTag(null), parseVersionTag(undefined)],
  [null, null, null]);

// ── compareVersions / isNewerVersion ────────────────────
check('compare: 0.37.10 is newer than 0.37.9, numerically',
  compareVersions('0.37.10', '0.37.9') === 1);
check('compare: padded equality', compareVersions('1.2', '1.2.0') === 0);
check('compare: v prefix does not matter', compareVersions('v1.2.3', '1.2.3') === 0);
check('compare: suffix does not matter', compareVersions('1.2.3-beta', '1.2.3') === 0);
check('compare: older is -1', compareVersions('0.37.1', '0.37.2') === -1);
check('compare: junk gives null', compareVersions('junk', '1.2.3') === null);
check('isNewerVersion: newer', isNewerVersion('v0.38.0', '0.37.9') === true);
check('isNewerVersion: equal', isNewerVersion('0.37.9', '0.37.9') === false);
check('isNewerVersion: junk is never newer', isNewerVersion('nightly', '0.37.9') === false);

// ── isUpdateCheckDue ────────────────────────────────────
const NOW = 1_800_000_000_000;
check('due: never checked', isUpdateCheckDue(0, NOW) === true);
check('due: 23 hours later is not due', isUpdateCheckDue(NOW - 23 * HOUR, NOW) === false);
check('due: exactly 24 hours is due', isUpdateCheckDue(NOW - UPDATE_INTERVAL_MS, NOW) === true);
check('due: 25 hours is due', isUpdateCheckDue(NOW - 25 * HOUR, NOW) === true);
check('due: a backwards clock is due rather than never', isUpdateCheckDue(NOW + HOUR, NOW) === true);
check('due: garbage counts as never checked', isUpdateCheckDue(NaN, NOW) === true);

// ── fetchLatestRelease ──────────────────────────────────
const URL = 'https://api.github.com/repos/Stashown/Example/releases/latest';

// Success: captures the four arguments fetchWithTimeout would receive.
{
  let seen = null;
  const fetchImpl = (url, options, timeoutMs, consume) => {
    seen = { url, options, timeoutMs };
    return consume({
      ok: true,
      json: async () => ({ tag_name: 'v0.37.2', name: 'ignore me' }),
    });
  };
  const res = await fetchLatestRelease({ url: URL, fetchImpl });
  eq('fetch: success reports the tag without the v', res, { ok: true, latestVersion: '0.37.2' });
  check('fetch: GET to the given URL', seen.url === URL && seen.options.method === 'GET');
  check('fetch: asks for the GitHub JSON media type',
    seen.options.headers.Accept === 'application/vnd.github+json');
  check('fetch: the public check never sends an Authorization header',
    !('Authorization' in seen.options.headers) && !('authorization' in seen.options.headers),
    JSON.stringify(seen.options.headers));
  check('fetch: no credentials or body travel with the check',
    seen.options.credentials === undefined && seen.options.body === undefined,
    JSON.stringify(Object.keys(seen.options)));
  check('fetch: the timeout is the 8 s update budget', seen.timeoutMs === UPDATE_TIMEOUT_MS);
}

// A caller can shorten the budget for a test.
{
  let seenTimeout = null;
  await fetchLatestRelease({
    url: URL,
    timeoutMs: 1234,
    fetchImpl: (url, options, timeoutMs, consume) => {
      seenTimeout = timeoutMs;
      return consume({ ok: true, json: async () => ({ tag_name: '1.2.3' }) });
    },
  });
  check('fetch: an explicit timeout is passed through', seenTimeout === 1234);
}

// HTTP failures keep the status for the caller.
{
  const res = await fetchLatestRelease({
    url: URL,
    fetchImpl: (url, options, timeoutMs, consume) => consume({
      ok: false,
      status: 403,
      json: async () => ({ message: 'rate limited' }),
    }),
  });
  eq('fetch: a non-2xx answer is reported as http with its status',
    res, { ok: false, reason: 'http', status: 403 });
}

// Unreadable body.
{
  const res = await fetchLatestRelease({
    url: URL,
    fetchImpl: (url, options, timeoutMs, consume) => consume({
      ok: true,
      json: async () => { throw new SyntaxError('bad json'); },
    }),
  });
  check('fetch: a body that is not JSON is a parse failure', res.reason === 'parse', JSON.stringify(res));
}

// A readable body with no usable tag.
{
  for (const body of [{}, { tag_name: 'nightly' }, { tag_name: null }]) {
    const res = await fetchLatestRelease({
      url: URL,
      fetchImpl: (url, options, timeoutMs, consume) => consume({ ok: true, json: async () => body }),
    });
    check(`fetch: unusable tag ${JSON.stringify(body)} is a tag failure`, res.reason === 'tag', JSON.stringify(res));
  }
}

// Transport failures.
{
  const timeout = await fetchLatestRelease({
    url: URL,
    fetchImpl: () => Promise.reject(new StashError('slow', 'timeout')),
  });
  check('fetch: the transport timeout is reported as timeout', timeout.reason === 'timeout', JSON.stringify(timeout));

  const network = await fetchLatestRelease({
    url: URL,
    fetchImpl: () => Promise.reject(new StashError('offline', 'network')),
  });
  check('fetch: a transport failure is reported as network', network.reason === 'network', JSON.stringify(network));

  const unknown = await fetchLatestRelease({
    url: URL,
    fetchImpl: () => Promise.reject(new Error('boom')),
  });
  check('fetch: an unexpected throw still fails closed', unknown.ok === false && unknown.reason === 'network');
}

// No URL means no request at all: the private build's state.
{
  let called = false;
  const res = await fetchLatestRelease({ url: '', fetchImpl: () => { called = true; } });
  eq('fetch: an unconfigured URL makes no request', res, { ok: false, reason: 'unconfigured' });
  check('fetch: ...and the transport was never called', called === false);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
