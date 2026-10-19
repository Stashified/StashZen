#!/usr/bin/env node
/**
 * check-bundle.mjs — refuse to ship an API key in the built bundle.
 *
 * Vite inlines `VITE_STASH_API_KEY` from `.env.production` at build time.
 * That is convenient for a local package aimed at your own TV and dangerous
 * for anything you hand to someone else: the key is then readable in the
 * JavaScript. CI has always had a grep for it, but a local `npm run build`
 * had nothing, and that is the path a shared `.wgt` more often comes from.
 *
 * Runs as npm's `postbuild`, so both `npm run build` and CI get it. It
 * NEVER prints the key: only file names and whether a key was found.
 *
 * CI (`process.env.CI`) never gets the opt-out. A local build may set
 * `ALLOW_BAKED_KEY=1` when the package is only for the builder's own TV;
 * that build must not be shared.
 *
 * Usage:
 *   node scripts/check-bundle.mjs
 *   ALLOW_BAKED_KEY=1 npm run build     # local, private package only
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stash API keys are JWTs, so `eyJhbGciOi` is the base64 of {"alg":... .
// Kept identical to the pattern the CI workflow has always used.
const JWT_MARKER = 'eyJhbGciOi';

// A private-network address in a release bundle means the builder's own
// server was inlined. Not a credential, but worth saying out loud.
//
// The one exception is the documented example address. It is the placeholder
// text in FirstRun's server field and the sample in `.env.example`, so it is
// in every bundle and a warning for it would fire on every clean build — the
// quickest way to teach people to scroll past the check. Match the address
// *and port* so the exemption cannot hide an unconnected address by accident.
const LAN_PLACEHOLDER = '192.168.1.10:9999';
const LAN_RE = /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;

/** Parse the KEY=value lines this project uses. Quotes and `export` allowed. */
export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values end at an unescaped ` #` comment.
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
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

/**
 * Scan `distDir` for credential-shaped content.
 *
 * @param {{ distDir: string, secret?: string }} opts
 * @returns {{ filesScanned: number, jwtFiles: string[], keyFiles: string[], lanFiles: string[] }}
 */
export function scanBundle({ distDir, secret = '' }) {
  const result = { filesScanned: 0, jwtFiles: [], keyFiles: [], lanFiles: [] };
  if (!existsSync(distDir)) return result;

  for (const rel of walk(distDir)) {
    const full = join(distDir, rel);
    const st = statSync(full);
    // Bundles are small text files. Skip anything that is obviously binary
    // rather than risk a false positive from compressed bytes.
    if (st.size > 8 * 1024 * 1024) continue;
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue; // unreadable entry: nothing this check can conclude from it
    }
    // A NUL byte is the usual quick tell for a binary file.
    if (text.includes('\u0000')) continue;

    result.filesScanned += 1;
    if (text.includes(JWT_MARKER)) result.jwtFiles.push(rel);
    if (secret && secret.length >= 8 && text.includes(secret)) result.keyFiles.push(rel);
    // Remove the documented placeholder first, then look for anything else —
    // a file may legitimately contain both.
    if (LAN_RE.test(text.split(LAN_PLACEHOLDER).join(''))) result.lanFiles.push(rel);
  }

  result.jwtFiles.sort();
  result.keyFiles.sort();
  result.lanFiles.sort();
  return result;
}

/**
 * Decide whether the bundle is shippable.
 *
 * `secret` is the key from `.env.production` when one exists; it is used for
 * a targeted search and never included in a returned message.
 *
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkBundle({ distDir, envText = null, secret = '', allowBaked = false, isCI = false }) {
  const lines = [];

  if (!existsSync(distDir)) {
    return { ok: false, lines: ['x dist/ does not exist — run the build first.'] };
  }

  if (isCI && envText !== null) {
    return {
      ok: false,
      lines: [
        'x .env.production is present in CI — refusing to package.',
        '  CI builds must not carry a Stash server address or API key.',
      ],
    };
  }

  const scan = scanBundle({ distDir, secret });
  const credentialFiles = [...new Set([...scan.jwtFiles, ...scan.keyFiles])];
  const baked = credentialFiles.length > 0;

  if (baked) {
    lines.push(
      allowBaked
        ? '! A Stash API key is inlined into dist/ (ALLOW_BAKED_KEY=1).'
        : 'x A Stash API key is inlined into dist/ — refusing to package it.',
    );
    lines.push(`  Found in: ${credentialFiles.join(', ')}`);
    lines.push('  A .wgt built from this dist/ hands the key to whoever installs it.');
    if (!allowBaked) {
      lines.push('  Rebuild without .env.production (CI does this automatically).');
      lines.push('  For a local package that is only for your own TV: ALLOW_BAKED_KEY=1 npm run build');
    }
  } else {
    lines.push(`ok bundle check: no credentials in dist/ (${scan.filesScanned} files scanned).`);
  }

  if (scan.lanFiles.length > 0) {
    lines.push(`! A private-network address is inlined into dist/: ${scan.lanFiles.join(', ')}`);
  }

  return { ok: !baked || allowBaked, lines };
}

function main() {
  const root = process.cwd();
  const envPath = join(root, '.env.production');
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : null;
  const secret = envText !== null ? (parseDotenv(envText).VITE_STASH_API_KEY || '') : '';
  const isCI = !!process.env.CI;
  const allowBaked = !isCI && process.env.ALLOW_BAKED_KEY === '1';

  const { ok, lines } = checkBundle({
    distDir: join(root, 'dist'),
    envText,
    secret,
    allowBaked,
    isCI,
  });

  for (const line of lines) console.log(line);
  process.exit(ok ? 0 : 1);
}

// Only run when invoked directly; the test imports the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
