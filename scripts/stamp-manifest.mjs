#!/usr/bin/env node
/**
 * stamp-manifest.mjs — put package.json's version into the staged Tizen manifest.
 *
 *   node scripts/stamp-manifest.mjs [dist/config.xml]
 *
 * `tizen/config.xml` carries its own `version`, which nothing kept in step with
 * package.json. The release workflow rewrites dist/config.xml before packaging,
 * but the README's manual build copies the file through untouched unless
 * stamped, so a local build would ship a manifest claiming the wrong version.
 * Every packaging path must stamp the same value.
 *
 * A script rather than `sed -i`: GNU sed takes `-i` bare and BSD sed requires
 * `-i ''`; the GNU form reads the `''` as the script and corrupts the file. One
 * script is the same command on every machine following the README.
 *
 * Re-running is a no-op; a missing file is a loud failure, since it means the
 * staging step this depends on did not happen.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const target = process.argv[2] ?? 'dist/config.xml';
const path = join(ROOT, target);

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

let xml;
try {
  xml = readFileSync(path, 'utf8');
} catch {
  console.error(`stamp-manifest: ${target} not found — stage it before stamping.`);
  process.exit(1);
}

// Anchored to the `<widget` element: a bare /version="[^"]*"/ can match
// `<tizen:application ... version="4.0"` and stamp the required Tizen version.
const VERSION_ATTR = /(<widget[^>]*\sversion=")[^"]*(")/;

// Test before replacing: no change is also what a successful stamp onto an
// already-correct manifest looks like, so it cannot distinguish a no-op from a
// regex that never matched.
if (!VERSION_ATTR.test(xml)) {
  console.error(`stamp-manifest: ${target} has no <widget … version="…"> attribute — nothing to stamp.`);
  process.exit(1);
}

const stamped = xml.replace(VERSION_ATTR, `$1${version}$2`);

writeFileSync(path, stamped);
console.log(`   ${target} stamped ${version}`);
