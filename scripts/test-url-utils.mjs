#!/usr/bin/env node
/**
 * test-url-utils.mjs: media URLs and the user-typed endpoint
 *
 *   node scripts/test-url-utils.mjs
 *
 * `withApiKey` decides where the key goes, and `normalizeEndpointUrl` is the
 * one rule both Settings and first-run use. The fragment and scheme cases are
 * pinned because both used to put the key where the server never sees it.
 */

import { setSettings } from '../src/utils/settings.js';
import { withApiKey } from '../src/utils/stashUrl.js';
import { normalizeEndpointUrl } from '../src/utils/endpointUrl.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── withApiKey ───────────────────────────────────────────
setSettings({ stashUrl: 'http://nas:9999', stashKey: 'KEY' });

check('a bare path on the configured host gets the key',
  withApiKey('http://nas:9999/screenshot/1') === 'http://nas:9999/screenshot/1?apikey=KEY');
check('an existing query gets an & separator',
  withApiKey('http://nas:9999/x?a=1') === 'http://nas:9999/x?a=1&apikey=KEY');
check('an already-authenticated URL is untouched',
  withApiKey('http://nas:9999/stream?apikey=OTHER') === 'http://nas:9999/stream?apikey=OTHER');
check('a signed stream URL also gets the key',
  withApiKey('http://nas:9999/scene/1/stream.m3u8?cid=abc&expires=123&signature=def')
    === 'http://nas:9999/scene/1/stream.m3u8?cid=abc&expires=123&signature=def&apikey=KEY');
check('a fragment keeps the key before it',
  withApiKey('http://nas:9999/x#frag') === 'http://nas:9999/x?apikey=KEY#frag',
  withApiKey('http://nas:9999/x#frag'));
check('a key after the fragment does not count as present',
  withApiKey('http://nas:9999/x#?apikey=OTHER') === 'http://nas:9999/x?apikey=KEY#?apikey=OTHER',
  withApiKey('http://nas:9999/x#?apikey=OTHER'));
// Stash builds its media URLs on `external_host` when it is set, so they can
// legitimately differ from the endpoint the TV talks to. Every URL passed here
// is a media path the server itself built, and it already has the key.
check('a media URL on another origin gets the key (external_host)',
  withApiKey('http://other:9999/x') === 'http://other:9999/x?apikey=KEY');
check('another scheme on the same host gets the key too',
  withApiKey('https://nas:9999/x') === 'https://nas:9999/x?apikey=KEY',
  withApiKey('https://nas:9999/x'));
check('a data URI is not a network asset and is untouched',
  withApiKey('data:image/svg+xml,<svg/>') === 'data:image/svg+xml,<svg/>');
check('a blob URL is not a network asset and is untouched',
  withApiKey('blob:http://nas:9999/abc') === 'blob:http://nas:9999/abc');
check('a relative path on the configured host gets the key',
  withApiKey('/x') === '/x?apikey=KEY', withApiKey('/x'));

setSettings({ stashKey: '' });
check('no configured key means no rewrite',
  withApiKey('http://nas:9999/x') === 'http://nas:9999/x');
setSettings({ stashUrl: 'not a url', stashKey: 'KEY' });
check('an unusable base is left alone',
  withApiKey('http://nas:9999/x') === 'http://nas:9999/x');

// ── normalizeEndpointUrl ─────────────────────────────────
const bare = normalizeEndpointUrl('192.168.1.20:8087');
check('a bare host:port becomes http://', bare.ok && bare.url === 'http://192.168.1.20:8087', bare.url);
check('whitespace is trimmed',
  normalizeEndpointUrl('  https://nas:8087  ').url === 'https://nas:8087');
check('an explicit http URL is kept',
  normalizeEndpointUrl('http://nas:8087/stash').url === 'http://nas:8087/stash');
check('an empty value is refused',
  !normalizeEndpointUrl('   ').ok);
check('a non-http scheme is refused',
  !normalizeEndpointUrl('ftp://nas:8087').ok, normalizeEndpointUrl('ftp://nas:8087').url);
check('a nonsense value is refused',
  !normalizeEndpointUrl('http://').ok);
check('a query string is refused',
  !normalizeEndpointUrl('http://nas:8087/?a=1').ok);
check('a bare query marker is refused',
  !normalizeEndpointUrl('http://nas:8087/?').ok);
check('a fragment is refused',
  !normalizeEndpointUrl('http://nas:8087/#x').ok);
check('embedded credentials are refused',
  !normalizeEndpointUrl('http://user:pass@nas:8087').ok,
  normalizeEndpointUrl('http://user:pass@nas:8087').url);
check('a bare username is refused too',
  !normalizeEndpointUrl('http://user@nas:8087').ok);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
