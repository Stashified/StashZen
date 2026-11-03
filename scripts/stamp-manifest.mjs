#!/usr/bin/env node
/**
 * stamp-manifest.mjs: put package.json's version and the app identity into the
 * staged Tizen manifest.
 *
 *   node scripts/stamp-manifest.mjs [dist/config.xml]
 *
 * `tizen/config.xml` carries its own `version`, which nothing kept in step with
 * package.json. The release workflow rewrites dist/config.xml before packaging,
 * but the README's manual build copies the file through untouched unless
 * stamped, so a local build would ship a manifest claiming the wrong version.
 * Every packaging path must stamp the same value.
 *
 * `APP_VARIANT=test` rewrites the identity so the build installs *alongside*
 * the main app: Tizen identifies an app by its package id, not its signature,
 * so a test-signed copy with the same id would replace the installed app. The
 * test package id is 10 characters like the main one, the TV's install limit.
 *
 * A script rather than `sed -i`: GNU sed takes `-i` bare and BSD sed requires
 * `-i ''`; the GNU form reads the `''` as the script and corrupts the file. One
 * script is the same command on every machine following the README.
 *
 * Re-running is a no-op; a missing file is a loud failure, since it means the
 * staging step this depends on did not happen.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// The staged manifest carries the main identity; the test variant is a
// separate app on the TV, so both the package and the application id change.
const MAIN = {
  widget: 'https://stashzen.local/StashZen',
  package: 'stashzentv',
  application: 'stashzentv.StashZen',
  name: 'StashZen',
};
// The ids the 0.36.2 test build used, and they must not change again: with an
// older test copy installed, apps2samsung silently refused a build whose id had
// moved (proven 2026-11-03). Keep this identity stable across test builds.
const TEST = {
  widget: 'https://stashzen.local/StashZenTest',
  package: 'stashzntst',
  application: 'stashzntst.StashZen',
  name: 'StashZen Test',
};

/**
 * Return `xml` with the test identity, or unchanged for `main`.
 * Throws rather than guessing when the expected source identity is missing: a
 * silently unstamped manifest would install over the main app.
 */
export function stampVariant(xml, variant = 'main') {
  if (variant === 'main') return xml;
  if (variant !== 'test') {
    throw new Error(`stamp-manifest: unknown variant '${variant}' (expected main or test)`);
  }

  const done = [TEST.widget, TEST.application, `<name>${TEST.name}</name>`]
    .every((needle) => xml.includes(needle));
  if (done) return xml;

  const replacements = [
    [`id="${MAIN.widget}"`, `id="${TEST.widget}"`],
    [`id="${MAIN.application}" package="${MAIN.package}"`,
      `id="${TEST.application}" package="${TEST.package}"`],
    [`<name>${MAIN.name}</name>`, `<name>${TEST.name}</name>`],
  ];
  let out = xml;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) {
      throw new Error(`stamp-manifest: cannot stamp the test variant, '${from}' is not in the manifest`);
    }
    out = out.replace(from, to);
  }
  return out;
}

function main() {
  const target = process.argv[2] ?? 'dist/config.xml';
  const path = join(ROOT, target);
  const variant = process.env.APP_VARIANT || 'main';

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
  // already-correct manifest looks like, so it cannot distinguish a no-op from
  // a regex that never matched.
  if (!VERSION_ATTR.test(xml)) {
    console.error(`stamp-manifest: ${target} has no <widget … version="…"> attribute — nothing to stamp.`);
    process.exit(1);
  }

  let stamped = xml.replace(VERSION_ATTR, `$1${version}$2`);
  try {
    stamped = stampVariant(stamped, variant);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  writeFileSync(path, stamped);
  console.log(`   ${target} stamped ${version}${variant === 'test' ? ' (test variant)' : ''}`);
}

// Importable by the manifest test without running the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
