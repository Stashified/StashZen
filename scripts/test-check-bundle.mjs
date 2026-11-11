#!/usr/bin/env node
/**
 * Tests for scripts/check-bundle.mjs.
 *
 * Fixtures go to a temp directory, not dist/. The fake token is assembled from
 * fragments so this file never contains a JWT-shaped literal.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotenv, scanBundle, checkBundle, readViteEnv } from './check-bundle.mjs';

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
    // The documented file is `.env`, not `.env.production`, and Vite merges
    // every file below in this order.
    const envDir = join(root, 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, '.env'), 'VITE_STASH_API_KEY=from-env\nVITE_USE_MOCK=true\n');
    writeFileSync(join(envDir, '.env.local'), 'VITE_STASH_API_KEY=from-local\n');
    writeFileSync(join(envDir, '.env.production'), 'VITE_STASH_API_KEY=from-prod\n');
    const got = readViteEnv(envDir);
    check('readViteEnv: every Vite file, in precedence order',
      got.files.join(',') === '.env,.env.local,.env.production', got.files.join(','));
    check('readViteEnv: a later file overrides an earlier one',
      got.env.VITE_STASH_API_KEY === 'from-prod', got.env.VITE_STASH_API_KEY);
    check('readViteEnv: other variables survive the merge',
      got.env.VITE_USE_MOCK === 'true', got.env.VITE_USE_MOCK);

    const only = join(root, 'env-key-only');
    mkdirSync(only, { recursive: true });
    writeFileSync(join(only, '.env'), 'VITE_STASH_API_KEY=only-key\n');
    check('readViteEnv: a key only in .env is found',
      readViteEnv(only).env.VITE_STASH_API_KEY === 'only-key');

    check('readViteEnv: no files means no text',
      readViteEnv(join(root, 'env-none')).text === null);
  }

  {
    const scan = scanBundle({ distDir: dist, secret: FAKE_KEY });
    check('clean bundle: scans both text files', scan.filesScanned === 2, `got ${scan.filesScanned}`);
    check('clean bundle: no JWT hit', scan.jwtFiles.length === 0);
    check('clean bundle: no key hit', scan.keyFiles.length === 0);
    check('clean bundle: no GitHub API hit', scan.githubApiFiles.length === 0);
    check('clean bundle: no changelog host hit', scan.changelogFiles.length === 0);
  }

  writeFileSync(join(dist, 'assets', 'binary.bin'), Buffer.from([0, 1, 2]));
  {
    const scan = scanBundle({ distDir: dist, secret: FAKE_KEY });
    check('binary file is reported as skipped', scan.skippedFiles.includes('assets/binary.bin'), scan.skippedFiles.join(','));
    check('skipped file is not counted as scanned', scan.filesScanned === 2, `got ${scan.filesScanned}`);
    const res = checkBundle({ distDir: dist, envText: 'x' });
    check(
      'summary reports the uninspected file',
      res.lines.some(l => l.includes('not inspected'))
        && res.lines.some(l => l.includes('binary.bin')),
      res.lines.join(' / '),
    );
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
    // No envText, so this reaches the key branch rather than the CI-env early
    // return above.
    const res = checkBundle({
      distDir: dist,
      secret: FAKE_KEY,
      allowBaked: true,
      isCI: true,
    });
    check('CI ignores ALLOW_BAKED_KEY for an inlined key', res.ok === false);
    check('...and says the key is inlined',
      res.lines.some(l => l.includes('A Stash API key is inlined')));
  }

  {
    const res = checkBundle({
      distDir: dist,
      envText: 'VITE_STASH_API_KEY=' + FAKE_KEY,
      secret: FAKE_KEY,
      allowBaked: true,
      isCI: true,
    });
    check('CI refuses a present .env.production', res.ok === false);
    check('CI reports .env.production', res.lines.some(l => l.includes('.env.production')));
  }

  {
    // The guard used to know only .env.production; a CI run carrying `.env`
    // (the file the README documents) must be refused too.
    const res = checkBundle({
      distDir: dist,
      envText: 'VITE_STASH_API_KEY=' + FAKE_KEY,
      envFiles: ['.env'],
      secret: FAKE_KEY,
      isCI: true,
    });
    check('CI refuses any Vite env file', res.ok === false);
    check('CI names the file it found', res.lines.some(l => l.includes('.env')));
  }

  {
    // A big text file is still readable. Treating it as binary would let a
    // large asset carry the key past a green check.
    const bigDist = join(root, 'big');
    mkdirSync(bigDist, { recursive: true });
    writeFileSync(join(bigDist, 'big.js'), `${'a'.repeat(8 * 1024 * 1024)}const k = "${FAKE_KEY}";`);
    const scan = scanBundle({ distDir: bigDist, secret: FAKE_KEY });
    check('a big text file is scanned, not skipped',
      scan.keyFiles.includes('big.js') && !scan.skippedFiles.includes('big.js'),
      `key=${scan.keyFiles.join(',')} skipped=${scan.skippedFiles.join(',')}`);

    const bigBin = join(root, 'bigbin');
    mkdirSync(bigBin, { recursive: true });
    writeFileSync(join(bigBin, 'big.bin'), Buffer.alloc(9 * 1024 * 1024));
    const binScan = scanBundle({ distDir: bigBin, secret: FAKE_KEY });
    check('a big binary file is still skipped', binScan.skippedFiles.includes('big.bin'));
  }

  {
    // A NUL byte makes a JS file look binary. Treating that as a clean skip
    // would let an unscannable source file hide a key.
    const hidden = join(root, 'hidden-text');
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, 'app.js'), Buffer.from([0x63, 0x00, 0x6f]));
    const res = checkBundle({ distDir: hidden });
    check('an unscannable text file fails the build', res.ok === false, res.lines.join(' | '));
    check('...and names the file', res.lines.some(l => l.includes('app.js')), res.lines.join(' | '));

    const image = join(root, 'image-skip');
    mkdirSync(image, { recursive: true });
    writeFileSync(join(image, 'icon.png'), Buffer.from([0x89, 0x00, 0x00]));
    const imgRes = checkBundle({ distDir: image });
    check('a skipped image still passes', imgRes.ok === true, imgRes.lines.join(' | '));
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
    // Size ceiling. A 621 KiB chunk trips it; a comment-like file just under
    // passes, which is the red control that the check measures rather than
    // rejects everything.
    const bigJs = join(root, 'big-js');
    mkdirSync(bigJs, { recursive: true });
    writeFileSync(join(bigJs, 'app.js'), 'x'.repeat(621 * 1024));
    const res = checkBundle({ distDir: bigJs });
    check('a bundle over the JS ceiling fails', res.ok === false,
      res.lines.join(' | '));
    check('...and says which side is over',
      res.lines.some(l => l.includes('JS ') && l.includes('/ 620.0 KiB')));

    const smallJs = join(root, 'small-js');
    mkdirSync(smallJs, { recursive: true });
    writeFileSync(join(smallJs, 'app.js'), 'x'.repeat(100 * 1024));
    const small = checkBundle({ distDir: smallJs });
    check('a bundle under both ceilings passes', small.ok === true,
      small.lines.join(' | '));
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

  {
    // The public update check's endpoint. Allowed only when the build was
    // explicitly armed; a private build carrying it is a wiring bug.
    // The public pair ships together, so a passing armed build carries both.
    const PUBLIC_CHANGELOG = 'https://raw.githubusercontent.com/x/y/main/changelog.json';
    const ghDist = join(root, 'gh');
    mkdirSync(ghDist, { recursive: true });
    writeFileSync(
      join(ghDist, 'app.js'),
      `const u = "https://api.github.com/repos/x/y/releases/latest"; const c = "${PUBLIC_CHANGELOG}";`,
    );

    const off = checkBundle({ distDir: ghDist });
    check('GitHub API URL fails an unarmed build', off.ok === false);
    check(
      'unarmed failure names the file',
      off.lines.some(l => l.includes('app.js')),
      off.lines.join(' | '),
    );
    check(
      'unarmed failure says how to arm',
      off.lines.some(l => l.includes('VITE_UPDATE_CHECK')),
      off.lines.join(' | '),
    );

    const ENDPOINT = 'https://api.github.com/repos/x/y/releases/latest';
    const on = checkBundle({
      distDir: ghDist, updateCheckEnabled: true, updateCheckUrl: ENDPOINT,
      changelogUrl: PUBLIC_CHANGELOG,
    });
    check('GitHub API URL passes an armed build', on.ok === true, on.lines.join(' | '));
    check(
      'armed message is an ok line',
      on.lines.some(l => l.startsWith('ok update check')),
      on.lines.join(' | '),
    );

    // Armed is not enough: the exact endpoint must be inlined, or a typo ships
    // a check that never fetches and CI stays green.
    const noUrl = checkBundle({
      distDir: ghDist, updateCheckEnabled: true, changelogUrl: PUBLIC_CHANGELOG,
    });
    check('an armed build without the URL fails', noUrl.ok === false, noUrl.lines.join(' | '));
    const wrongUrl = checkBundle({
      distDir: ghDist, updateCheckEnabled: true, changelogUrl: PUBLIC_CHANGELOG,
      updateCheckUrl: 'https://api.github.com/repos/x/z/releases/latest',
    });
    check('an armed build with another endpoint fails',
      wrongUrl.ok === false, wrongUrl.lines.join(' | '));

    const emptyDist = join(root, 'armed-empty');
    mkdirSync(emptyDist, { recursive: true });
    writeFileSync(join(emptyDist, 'app.js'), 'console.log("hi");');
    const missing = checkBundle({
      distDir: emptyDist, updateCheckEnabled: true, updateCheckUrl: ENDPOINT,
      changelogUrl: PUBLIC_CHANGELOG,
    });
    check('an armed build with no API URL at all fails',
      missing.ok === false, missing.lines.join(' | '));

    // Independent of the credential switch: one must not wave the other past.
    const baked = checkBundle({ distDir: ghDist, allowBaked: true });
    check('ALLOW_BAKED_KEY does not bypass the URL check', baked.ok === false, baked.lines.join(' | '));
  }

  {
    // Only the API host counts. The same repo's human URL is ordinary copy.
    const plainDist = join(root, 'plain-gh');
    mkdirSync(plainDist, { recursive: true });
    writeFileSync(
      join(plainDist, 'app.js'),
      'const u = "https://github.com/Stashified/StashZen/releases";',
    );
    const scan = scanBundle({ distDir: plainDist });
    check('plain github.com is not an API hit', scan.githubApiFiles.length === 0, scan.githubApiFiles.join(','));
    check('plain github.com link passes', checkBundle({ distDir: plainDist }).ok === true);
  }

  {
    // The changelog host. Armed by its own URL, but the public pair moves
    // together: an update-armed build must also carry the changelog URL.
    const CHANGELOG = 'https://raw.githubusercontent.com/Stashified/StashZen/main/changelog.json';
    const rawDist = join(root, 'raw-gh');
    mkdirSync(rawDist, { recursive: true });
    writeFileSync(join(rawDist, 'app.js'), `const c = "${CHANGELOG}";`);

    const scan = scanBundle({ distDir: rawDist });
    check('the changelog host is detected',
      scan.changelogFiles.includes('app.js'), scan.changelogFiles.join(','));

    const off = checkBundle({ distDir: rawDist });
    check('the changelog URL fails an unarmed build', off.ok === false, off.lines.join(' | '));
    check('the unarmed changelog failure names the file',
      off.lines.some(l => l.includes('app.js')), off.lines.join(' | '));
    check('the unarmed changelog failure says how to arm',
      off.lines.some(l => l.includes('VITE_CHANGELOG_URL')), off.lines.join(' | '));

    // The pair is armed together, so a changelog URL with the update check off
    // is still an unarmed build. This used to fall through to "ok changelog".
    const unarmedUrl = checkBundle({ distDir: rawDist, changelogUrl: CHANGELOG });
    check('a changelog URL without the update check fails',
      unarmedUrl.ok === false, unarmedUrl.lines.join(' | '));
    // The right failure, not just any failure: this is the branch the reorder
    // moved, and an unrelated red would pass the check above.
    check('the unarmed-URL failure names the arming pair',
      unarmedUrl.lines.some(l => l.includes('VITE_UPDATE_CHECK')), unarmedUrl.lines.join(' | '));

    const UPDATE = 'https://api.github.com/repos/x/y/releases/latest';
    writeFileSync(join(rawDist, 'app.js'), `const u = "${UPDATE}"; const c = "${CHANGELOG}";`);
    const on = checkBundle({
      distDir: rawDist, updateCheckEnabled: true, updateCheckUrl: UPDATE, changelogUrl: CHANGELOG,
    });
    check('the exact changelog URL passes an armed build',
      on.ok === true, on.lines.join(' | '));
    check('the armed changelog message is an ok line',
      on.lines.some(l => l.startsWith('ok changelog')), on.lines.join(' | '));

    const wrong = checkBundle({
      distDir: rawDist,
      updateCheckEnabled: true,
      updateCheckUrl: UPDATE,
      changelogUrl: 'https://raw.githubusercontent.com/Stashified/StashZen/main/other.json',
    });
    check('an armed changelog with another endpoint fails',
      wrong.ok === false, wrong.lines.join(' | '));

    // The public pair cannot drift: an update-armed build with no changelog
    // URL is refused even though its own endpoint is present.
    const bothDist = join(root, 'public-pair');
    mkdirSync(bothDist, { recursive: true });
    writeFileSync(join(bothDist, 'app.js'), `const u = "${UPDATE}"; const c = "${CHANGELOG}";`);
    const drift = checkBundle({
      distDir: bothDist, updateCheckEnabled: true, updateCheckUrl: UPDATE,
    });
    check('an update-armed build without the changelog URL fails',
      drift.ok === false, drift.lines.join(' | '));
    check('...and says the changelog URL is missing',
      drift.lines.some(l => l.includes('changelog URL is not set')), drift.lines.join(' | '));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── the script itself: env precedence, symlinked invocation ─
// Importing the helpers cannot cover these, and each one was a silent green.
{
  const bin = fileURLToPath(new URL('./check-bundle.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'stashzen-bundle-cli-'));
  try {
    const dist = join(dir, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'app.js'), 'const k = "process-only-key-1234";');
    writeFileSync(join(dir, '.env'), 'VITE_STASH_API_KEY=file-only-key-5678\n');

    const env = { ...process.env, VITE_STASH_API_KEY: 'process-only-key-1234' };
    delete env.ALLOW_BAKED_KEY;
    delete env.CI;
    env.VITE_UPDATE_CHECK = '';
    const run = spawnSync(process.execPath, [bin], {
      cwd: dir, env, encoding: 'utf8', timeout: 60_000,
    });
    check('the process environment wins over the env file', run.status === 1,
      `status=${run.status} ${run.stdout}`);
    check('...and the refusal names the inlined key',
      run.stdout.includes('A Stash API key is inlined'), run.stdout);

    // The guard must run when the entry point is a symlink, not exit 0.
    const linkDir = join(dir, 'link');
    mkdirSync(linkDir);
    const link = join(linkDir, 'guard.mjs');
    // Creating a symlink needs a privilege Windows does not grant by default;
    // that is no reason to fail the whole test chain.
    let linked = null;
    try {
      symlinkSync(bin, link);
      linked = spawnSync(process.execPath, [link], {
        cwd: linkDir, env, encoding: 'utf8', timeout: 60_000,
      });
    } catch (err) {
      console.log(`  skip symlink checks (${err.code || err.message})`);
    }
    if (linked) {
      check('a symlinked invocation still runs the guard', linked.status === 1,
        `status=${linked.status} ${linked.stdout}`);
      check('...and reports the missing dist',
        linked.stdout.includes('dist/ does not exist'), linked.stdout);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
