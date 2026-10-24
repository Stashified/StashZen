#!/usr/bin/env node
/**
 * test-manifest.mjs — keep tizen/config.xml honest
 *
 *   node scripts/test-manifest.mjs
 *
 * `tizen/config.xml` carries its own copy of two values that live elsewhere:
 * the widget version (package.json) and the Tizen floor (scripts/compat-floor.mjs).
 * Both have drifted before. The version was wrong for four consecutive releases
 * (see stamp-manifest.mjs), and the floor is the one number a wrong edit would
 * silently widen — the app would install on a TV whose engine cannot render it.
 *
 * The release workflow seds the version in and never reads the floor, so
 * neither mistake shows in a CI artifact. That is exactly why this runs in
 * `npm test` instead: it checks the source file every packaging path copies.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COMPAT_LABEL } from './compat-floor.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const xml = readFileSync(join(ROOT, 'tizen', 'config.xml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Anchored to `<widget`, like stamp-manifest's regex: a bare /version="…"/
// also matches `<tizen:application … version="4.0"` (the Tizen API level).
const widget = /<widget\b[^>]*>/.exec(xml)?.[0] || '';
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};

check('the manifest has a <widget> element', widget !== '', 'no <widget …> found');

check('the widget version matches package.json',
  attr(widget, 'version') === pkg.version,
  `manifest=${attr(widget, 'version')} package.json=${pkg.version}`);

// COMPAT_LABEL is "Tizen 6.5 (Chromium 94)"; the manifest wants just "6.5".
const floor = COMPAT_LABEL.match(/^Tizen (\d+(?:\.\d+)*)/)?.[1] || null;
// The floor lives on <tizen:application>, not on <widget>.
const application = /<tizen:application\b[^>]*>/.exec(xml)?.[0] || '';
check('the compat floor is readable from COMPAT_LABEL', floor !== null, COMPAT_LABEL);
check('required_version matches the compat floor',
  attr(application, 'required_version') === floor,
  `manifest=${attr(application, 'required_version')} floor=${floor}`);

// `package` must be EXACTLY 10 characters. `tizen package` accepts anything;
// the TV's security manager then fails to parse the archive at install time
// with `[118, -4] "Operation not allowed : Load archive info fail"`, which
// reads like a signing or Tizen-version problem. An 8-character id cost a
// broken release once. Only the package half is constrained — the
// application-name half after the dot is not.
const packageId = attr(application, 'package');
const applicationId = attr(application, 'id');
check('the package id is exactly 10 characters',
  typeof packageId === 'string' && packageId.length === 10,
  `package=${packageId} (${packageId ? packageId.length : 0} chars)`);
check('the application id is namespaced by the package id',
  !!applicationId && !!packageId && applicationId.split('.')[0] === packageId,
  `application id=${applicationId} package=${packageId}`);

// Upstream shipped a placeholder here; a copied-through value would bake
// someone else's domain into the widget.
const widgetId = attr(widget, 'id');
check('the widget id is not upstream\'s placeholder',
  !!widgetId && !/yourdomain/.test(widgetId), `widget id=${widgetId}`);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
