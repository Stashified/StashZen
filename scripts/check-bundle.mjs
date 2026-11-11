#!/usr/bin/env node
/**
 * check-bundle.mjs: refuse to ship an API key in the built bundle.
 *
 * Vite inlines `VITE_STASH_API_KEY` at build time. Fine for a local package on
 * your own TV, dangerous for anything handed to someone else: the key is then
 * readable in the JavaScript. A local `npm run build` is the path a shared
 * `.wgt` more often comes from.
 *
 * Reads the same files Vite does: `.env`, `.env.local`, `.env.production` and
 * `.env.production.local`, later files overriding earlier ones, plus the
 * process environment. `.env` is the file the README documents, so reading
 * only `.env.production` missed the usual local build.
 *
 * Runs as npm's `postbuild`, so both `npm run build` and CI get it. It NEVER
 * prints the key: only file names and whether a key was found.
 *
 * CI (`process.env.CI`) never gets the opt-out. A local build may set
 * `ALLOW_BAKED_KEY=1` when the package is only for the builder's own TV; that
 * build must not be shared.
 *
 * Usage:
 *   node scripts/check-bundle.mjs
 *   ALLOW_BAKED_KEY=1 npm run build     # local, private package only
 */

import {
  readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync,
  realpathSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotenv } from './parse-dotenv.mjs';

// Stash API keys are JWTs, so `eyJhbGciOi` is the base64 of {"alg":... .
// Kept identical to the pattern the CI workflow has always used.
const JWT_MARKER = 'eyJhbGciOi';

// The public update check's endpoint. Only the public build may inline it; a
// private build carrying it means the gate was wired wrong.
const GITHUB_API_MARKER = 'api.github.com';

// The changelog's public host. Same rule, separate URL: the two public-only
// features are armed together, so a build with one and not the other is a
// wiring bug rather than a smaller build.
const CHANGELOG_MARKER = 'raw.githubusercontent.com';

// A private-network address in a release bundle means the builder's own server
// was inlined. Not a credential, but worth saying.
//
// The documented example address is exempt: it is FirstRun's placeholder and
// `.env.example`'s sample, so it is in every bundle and a warning for it would
// fire on every clean build. Match the address *and port* so the exemption
// cannot hide an unconnected address by accident.
// Sizes are a tripwire against an accidental dependency, not a target: a few
// hundred kB on a TV's flash and a cold start matters, and nothing else in CI
// notices when a bundle grows. Both budgets have ~15% headroom over 0.41.0;
// raising them is a decision, which is why the message says so.
const MAX_JS_BYTES = 620 * 1024;
const MAX_CSS_BYTES = 120 * 1024;

// Skipping an image or a font is harmless; skipping a JS or JSON file means a
// credential scan never looked at something that can hold a string.
const TEXT_ASSET_RE = /\.(?:m?js|css|html?|json|map|xml|txt|svg)$/i;

const LAN_PLACEHOLDER = '192.168.1.10:9999';
const LAN_RE = /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;

// The parser lives in parse-dotenv.mjs; re-exported for existing imports.
export { parseDotenv };

// The files a production `vite build` loads, in precedence order: a later file
// overrides an earlier one. `npm run build` is always mode=production.
export const VITE_ENV_FILES = [
  '.env', '.env.local', '.env.production', '.env.production.local',
];

/**
 * Read those files from `root`, merged in Vite's order. `files` is what exists,
 * `env` is the merged result, and `text` their concatenated contents (null if
 * none exist), which is all the CI presence check needs.
 */
export function readViteEnv(root) {
  const files = [];
  const env = {};
  let text = null;
  for (const name of VITE_ENV_FILES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const contents = readFileSync(path, 'utf8');
    files.push(name);
    text = (text ?? '') + contents + '\n';
    Object.assign(env, parseDotenv(contents));
  }
  return { files, env, text };
}

function walk(dir, base = dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...walk(full, base));
    else if (st.isFile()) files.push(relative(base, full));
  }
  return files;
}

// A big file's first block tells binary from text without reading all of it.
function peekBinary(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(8192);
    const n = readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan `distDir` for credential-shaped content.
 *
 * @param {{ distDir: string, secret?: string }} opts
 * @returns {{ filesScanned: number, skippedFiles: string[], jwtFiles: string[], keyFiles: string[], lanFiles: string[], githubApiFiles: string[], changelogFiles: string[] }}
 */
export function scanBundle({ distDir, secret = '' }) {
  const result = {
    filesScanned: 0, skippedFiles: [], jwtFiles: [], keyFiles: [], lanFiles: [],
    githubApiFiles: [], changelogFiles: [],
  };
  if (!existsSync(distDir)) return result;

  for (const rel of walk(distDir)) {
    const full = join(distDir, rel);
    const st = statSync(full);
    // Skip only binary files. A big *text* file is still readable and may
    // carry the key, so it must be scanned rather than reported as clean.
    let text;
    try {
      if (st.size > 8 * 1024 * 1024 && peekBinary(full)) {
        result.skippedFiles.push(rel);
        continue;
      }
      text = readFileSync(full, 'utf8');
    } catch {
      result.skippedFiles.push(rel); // unreadable: nothing this check can conclude
      continue;
    }
    // A NUL byte is the usual quick tell for a binary file.
    if (text.includes('\u0000')) {
      result.skippedFiles.push(rel);
      continue;
    }

    result.filesScanned += 1;
    if (text.includes(JWT_MARKER)) result.jwtFiles.push(rel);
    if (secret && secret.length >= 8 && text.includes(secret)) result.keyFiles.push(rel);
    if (text.includes(GITHUB_API_MARKER)) result.githubApiFiles.push(rel);
    if (text.includes(CHANGELOG_MARKER)) result.changelogFiles.push(rel);
    // Remove the documented placeholder first, then look for anything else: a
    // file may legitimately contain both.
    if (LAN_RE.test(text.split(LAN_PLACEHOLDER).join(''))) result.lanFiles.push(rel);
  }

  result.jwtFiles.sort();
  result.keyFiles.sort();
  result.lanFiles.sort();
  result.githubApiFiles.sort();
  result.changelogFiles.sort();
  return result;
}

/**
 * Decide whether the bundle is shippable.
 *
 * `secret` is the key Vite would inline, from the env files or the process
 * environment; it is used for a targeted search and never included in a
 * returned message. `envFiles` names the files that exist, for the CI refusal.
 *
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkBundle({
  distDir, envText = null, envFiles = [], secret = '', allowBaked = false, isCI = false,
  updateCheckEnabled = false, updateCheckUrl = '', changelogUrl = '',
}) {
  const lines = [];

  if (!existsSync(distDir)) {
    return { ok: false, lines: ['x dist/ does not exist — run the build first.'] };
  }

  if (isCI && (envText !== null || envFiles.length > 0)) {
    const found = envFiles.length > 0 ? envFiles : ['.env.production'];
    return {
      ok: false,
      lines: [
        'x A Vite env file is present in CI: refusing to package.',
        `  Found: ${found.join(', ')}`,
        '  CI builds must not carry a Stash server address or API key.',
      ],
    };
  }

  const scan = scanBundle({ distDir, secret });
  const credentialFiles = [...new Set([...scan.jwtFiles, ...scan.keyFiles])];
  const baked = credentialFiles.length > 0;
  const unscannedText = scan.skippedFiles.filter(rel => TEXT_ASSET_RE.test(rel));
  // Enforced here too, not only in main(): CI never gets the opt-out.
  const effectiveAllowBaked = allowBaked && !isCI;

  if (baked) {
    lines.push(
      effectiveAllowBaked
        ? '! A Stash API key is inlined into dist/ (ALLOW_BAKED_KEY=1).'
        : 'x A Stash API key is inlined into dist/ — refusing to package it.',
    );
    lines.push(`  Found in: ${credentialFiles.join(', ')}`);
    lines.push('  A .wgt built from this dist/ hands the key to whoever installs it.');
    if (!effectiveAllowBaked) {
      lines.push('  Rebuild without .env.production (CI does this automatically).');
      lines.push('  For a local package that is only for your own TV: ALLOW_BAKED_KEY=1 npm run build');
    }
  } else {
    const skipped = scan.skippedFiles.length
      ? `; ${scan.skippedFiles.length} not inspected`
      : '';
    lines.push(`ok bundle check: no credentials in dist/ (${scan.filesScanned} files scanned${skipped}).`);
    if (scan.skippedFiles.length) {
      lines.push(`! Not inspected (binary or over 8 MiB): ${scan.skippedFiles.join(', ')}`);
    }
  }
  if (unscannedText.length > 0) {
    lines.push('x A text bundle file could not be scanned for credentials.');
    lines.push(`  Found: ${unscannedText.join(', ')}`);
  }

  if (scan.lanFiles.length > 0) {
    lines.push(`! A private-network address is inlined into dist/: ${scan.lanFiles.join(', ')}`);
  }

  // Every chunk, lazy ones included: they all land in the .wgt and all have to
  // be parsed at some point.
  const size = { js: 0, css: 0 };
  for (const rel of walk(distDir)) {
    if (rel.endsWith('.js')) size.js += statSync(join(distDir, rel)).size;
    else if (rel.endsWith('.css')) size.css += statSync(join(distDir, rel)).size;
  }
  const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
  const overJs = size.js > MAX_JS_BYTES;
  const overCss = size.css > MAX_CSS_BYTES;
  if (overJs || overCss) {
    lines.push('x The bundle is over its size ceiling.');
    if (overJs) lines.push(`  JS ${kib(size.js)} / ${kib(MAX_JS_BYTES)}`);
    if (overCss) lines.push(`  CSS ${kib(size.css)} / ${kib(MAX_CSS_BYTES)}`);
    lines.push('  If the growth is intended, raise MAX_JS_BYTES / MAX_CSS_BYTES in scripts/check-bundle.mjs.');
  } else {
    lines.push(`ok bundle size: JS ${kib(size.js)} / ${kib(MAX_JS_BYTES)}, `
      + `CSS ${kib(size.css)} / ${kib(MAX_CSS_BYTES)}.`);
  }

  // Fail closed both ways. An unarmed build must not carry the endpoint, and
  // an armed one must carry the exact URL: an empty or mistyped URL left the
  // public release with a hidden or 404ing check and a green guard.
  let updateBlocked = false;
  const endpointFound = !!updateCheckUrl && scan.githubApiFiles.some(rel =>
    readFileSync(join(distDir, rel), 'utf8').includes(updateCheckUrl));
  if (!updateCheckEnabled) {
    if (scan.githubApiFiles.length > 0) {
      updateBlocked = true;
      lines.push('x A GitHub API URL is inlined into dist/ but the update check is not armed.');
      lines.push(`  Found in: ${scan.githubApiFiles.join(', ')}`);
      lines.push('  Only the public build may carry it: set VITE_UPDATE_CHECK=true and VITE_UPDATE_CHECK_URL.');
    }
  } else if (!endpointFound) {
    updateBlocked = true;
    lines.push('x The update check is armed but its endpoint is not in dist/.');
    lines.push('  Set VITE_UPDATE_CHECK_URL to the release endpoint.');
  } else {
    lines.push(`ok update check: the public GitHub API URL is in dist/ (${scan.githubApiFiles.join(', ')}).`);
  }

  // The changelog's own gate. The public pair moves together: an update-armed
  // build without a changelog URL would ship a viewer with no endpoint, and an
  // unarmed build carrying raw.githubusercontent.com means a URL leaked.
  let changelogBlocked = false;
  const changelogFound = !!changelogUrl && scan.changelogFiles.some(rel =>
    readFileSync(join(distDir, rel), 'utf8').includes(changelogUrl));
  // Branch on the armed flag first: a URL set without the update check is an
  // unarmed build, and the old order let its raw.githubusercontent.com marker
  // fall through to "ok changelog".
  if (!updateCheckEnabled) {
    if (scan.changelogFiles.length > 0) {
      changelogBlocked = true;
      lines.push('x A raw.githubusercontent.com URL is inlined into dist/ but the update check is not armed.');
      lines.push(`  Found in: ${scan.changelogFiles.join(', ')}`);
      lines.push('  Only the public build may carry it: set VITE_UPDATE_CHECK=true and VITE_CHANGELOG_URL.');
    }
  } else if (!changelogUrl) {
    changelogBlocked = true;
    lines.push('x The update check is armed but the changelog URL is not set.');
    lines.push('  Set VITE_CHANGELOG_URL to the public changelog endpoint.');
  } else if (!changelogFound) {
    changelogBlocked = true;
    lines.push('x The changelog is armed but its endpoint is not in dist/.');
    lines.push('  Set VITE_CHANGELOG_URL to the changelog endpoint.');
  } else {
    lines.push(`ok changelog: the public changelog URL is in dist/ (${scan.changelogFiles.join(', ')}).`);
  }

  return {
    ok: (!baked || effectiveAllowBaked) && !updateBlocked && !changelogBlocked
      && unscannedText.length === 0 && !overJs && !overCss,
    lines,
  };
}

function main() {
  const root = process.cwd();
  const { files: envFiles, env, text: envText } = readViteEnv(root);
  // Vite merges the process environment over the env files, so this guard has
  // to read the merged map or it searches for a stale key while an inline
  // VITE_STASH_API_KEY=… npm run build inlines the real one.
  const merged = { ...env, ...process.env };
  const secret = merged.VITE_STASH_API_KEY || '';
  const isCI = !!process.env.CI;
  const allowBaked = !isCI && process.env.ALLOW_BAKED_KEY === '1';

  const { ok, lines } = checkBundle({
    distDir: join(root, 'dist'),
    envText,
    envFiles,
    secret,
    allowBaked,
    isCI,
    updateCheckEnabled: merged.VITE_UPDATE_CHECK === 'true',
    updateCheckUrl: merged.VITE_UPDATE_CHECK_URL || '',
    changelogUrl: merged.VITE_CHANGELOG_URL || '',
  });

  for (const line of lines) console.log(line);
  process.exit(ok ? 0 : 1);
}

// Only run when invoked directly; the test imports the functions above. Real
// paths, so a symlinked invocation still runs the guard instead of exiting 0.
function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  const here = fileURLToPath(import.meta.url);
  try {
    return realpathSync(here) === realpathSync(arg);
  } catch {
    return resolve(here) === resolve(arg);
  }
}

if (invokedDirectly()) {
  main();
}
