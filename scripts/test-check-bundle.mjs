#!/usr/bin/env node
/**
 * Tests for scripts/check-bundle.mjs.
 *
 * Fixtures go to a temp directory, not dist/. The fake token is assembled from
 * fragments so this file never contains a JWT-shaped literal.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDotenv, scanBundle, checkBundle } from './check-bundle.mjs';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const FAKE_JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiJ4In0.abc';
const FAKE_KEY = 'fake-stash-key-4f8a9c';

// ── parseDotenv ──────────────────────────────────────────
{
  const env = parseDotenv([
    '# comment',
    'VITE_STASH_URL="http://192.168.1.10:9999"',
    "VITE_STASH_API_KEY='abc123'",
    'export VITE_USE_MOCK=false',
    'OTHER = value # trailing comment',
  ].join('\n'));
  check('parseDotenv: quoted URL', env.VITE_STASH_URL === 'http://192.168.1.10:9999', env.VITE_STASH_URL);
  check('parseDotenv: single-quoted key', env.VITE_STASH_API_KEY === 'abc123', env.VITE_STASH_API_KEY);
  check('parseDotenv: export prefix', env.VITE_USE_MOCK === 'false', env.VITE_USE_MOCK);
  check('parseDotenv: trailing comment stripped', env.OTHER === 'value', env.OTHER);
}

// ── scanBundle / checkBundle fixtures ────────────────────
const root = mkdtempSync(join(tmpdir(), 'stashzen-bundle-'));
try {
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html><script src="./assets/app.js"></script></html>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("hello");');

  {
    const scan = scanBundle({ distDir: dist, secret: FAKE_KEY });
    check('clean bundle: scans both text files', scan.filesScanned === 2, `got ${scan.filesScanned}`);
    check('clean bundle: no JWT hit', scan.jwtFiles.length === 0);
    check('clean bundle: no key hit', scan.keyFiles.length === 0);
  }

  writeFileSync(join(dist, 'assets', 'leak.js'), `const k = "${FAKE_JWT}";`);
  {
    const scan = scanBundle({ distDir: dist, secret: FAKE_KEY });
    check('JWT-shaped string is detected', scan.jwtFiles.includes('assets/leak.js'), scan.jwtFiles.join(','));
  }

  writeFileSync(join(dist, 'assets', 'key.js'), `const k = "${FAKE_KEY}";`);
  {
    const scan = scanBundle({ distDir: dist, secret: FAKE_KEY });
    check('exact API key is detected', scan.keyFiles.includes('assets/key.js'), scan.keyFiles.join(','));
  }

  {
    const res = checkBundle({
      distDir: dist,
      envText: 'VITE_STASH_API_KEY=' + FAKE_KEY,
      secret: FAKE_KEY,
    });
    check('leak fails the build', res.ok === false);
    check('leak message names the file', res.lines.some(l => l.includes('assets/leak.js') || l.includes('assets/key.js')));
    check(
      'leak message never prints the key',
      !res.lines.join('\n').includes(FAKE_KEY) && !res.lines.join('\n').includes(FAKE_JWT),
    );
  }

  {
    const res = checkBundle({
      distDir: dist,
      envText: 'VITE_STASH_API_KEY=' + FAKE_KEY,
      secret: FAKE_KEY,
      allowBaked: true,
    });
    check('ALLOW_BAKED_KEY downgrades a local leak to a warning', res.ok === true);
    check('warning still names the file', res.lines.some(l => l.includes('assets/leak.js')));
  }

  {
    const res = checkBundle({
      distDir: dist,
      envText: 'VITE_STASH_API_KEY=' + FAKE_KEY,
      secret: FAKE_KEY,
      allowBaked: true,
      isCI: true,
    });
    check('CI ignores ALLOW_BAKED_KEY', res.ok === false);
    check('CI reports .env.production', res.lines.some(l => l.includes('.env.production')));
  }

  {
    // A LAN address alone is a warning, not a failure.
    const cleanDist = join(root, 'clean');
    mkdirSync(cleanDist, { recursive: true });
    writeFileSync(join(cleanDist, 'app.js'), 'const url = "http://192.168.1.20:9999";');
    const res = checkBundle({ distDir: cleanDist });
    check('LAN address alone passes', res.ok === true);
    check(
      'LAN address is warned about by file',
      res.lines.some(l => l.startsWith('!') && l.includes('private-network') && l.includes('app.js')),
    );
  }

  {
    // The documented example is in every bundle (FirstRun's placeholder), so
    // warning on it would make the warning meaningless. The `.20` case above is
    // the red control proving the guard is still on.
    const placeholderDist = join(root, 'placeholder');
    mkdirSync(placeholderDist, { recursive: true });
    writeFileSync(join(placeholderDist, 'app.js'), 'const url = "http://192.168.1.10:9999";');
    const res = checkBundle({ distDir: placeholderDist });
    check('documented placeholder alone passes', res.ok === true);
    check(
      'documented placeholder produces no warning',
      !res.lines.some(l => l.includes('private-network')),
      res.lines.join(' | '),
    );
  }

  {
    // The exemption is per-occurrence, not per-file: stripping the sample
    // must not mask a second, real address in the same file.
    const mixedDist = join(root, 'mixed');
    mkdirSync(mixedDist, { recursive: true });
    writeFileSync(
      join(mixedDist, 'app.js'),
      'const a = "http://192.168.1.10:9999"; const b = "http://192.168.1.20:9999";',
    );
    const res = checkBundle({ distDir: mixedDist });
    check(
      'placeholder does not mask a real address in the same file',
      res.lines.some(l => l.includes('private-network') && l.includes('app.js')),
      res.lines.join(' | '),
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
