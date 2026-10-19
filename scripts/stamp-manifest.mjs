#!/usr/bin/env node
/**
 * stamp-manifest.mjs — put package.json's version into the staged Tizen manifest.
 *
 *   node scripts/stamp-manifest.mjs [dist/config.xml]
 *
 * **Why this exists.** `tizen/config.xml` carries its own `version` attribute,
 * and nothing in the repo kept it in step with `package.json`. It drifted: the
 * file said `0.10.1` while package.json said `0.13.0`, and had been wrong for
 * four releases. It did not show in shipped artifacts, because the release
 * workflow seds the real version into `dist/config.xml` before packaging — but
 * the manual build in the README copies the file through untouched unless it
 * is stamped, so a **local** build would ship a widget manifest claiming a
 * version it was not. A version that is only right when CI builds it is a
 * trap, and the fix is for every path that packages to stamp the same value.
 *
 * **Why a script.** `sed -i` is not portable: GNU sed takes `-i` bare and BSD
 * sed requires `-i ''`, so a line that works in one corrupts the file in the
 * other (GNU reads the `''` as the script). One small script is the same
 * command on every machine following the README.
 *
 * Deliberately not idempotent-hostile: re-running it is a no-op, and a missing
 * file is a loud failure rather than a silent skip — the staging step it
 * depends on having happened is exactly the thing that would otherwise be
 * missed.
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

// Anchored to the `<widget` element's own attribute: a bare /version="[^"]*"/
// would match `<tizen:application ... version="4.0"` first if the attributes
// were ever reordered, and would silently stamp the *required Tizen version*.
const stamped = xml.replace(/(<widget[^>]*\sversion=")[^"]*(")/, `$1${version}$2`);

if (stamped === xml && !xml.includes(`<widget`) ) {
  console.error(`stamp-manifest: ${target} has no <widget> element — nothing to stamp.`);
  process.exit(1);
}

writeFileSync(path, stamped);
console.log(`   ${target} stamped ${version}`);
