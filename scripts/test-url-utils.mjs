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
check('a fragment keeps the key before it',
  withApiKey('http://nas:9999/x#frag') === 'http://nas:9999/x?apikey=KEY#frag',
  withApiKey('http://nas:9999/x#frag'));
check('a key after the fragment does not count as present',
  withApiKey('http://nas:9999/x#?apikey=OTHER') === 'http://nas:9999/x?apikey=KEY#?apikey=OTHER',
  withApiKey('http://nas:9999/x#?apikey=OTHER'));
check('another host is untouched',
  withApiKey('http://other:9999/x') === 'http://other:9999/x');
check('another scheme on the same host is untouched',
  withApiKey('https://nas:9999/x') === 'https://nas:9999/x',
  withApiKey('https://nas:9999/x'));
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

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
