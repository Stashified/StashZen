#!/usr/bin/env node
/**
 * test-manifest.mjs: keep tizen/config.xml honest
 *
 *   node scripts/test-manifest.mjs
 *
 * `tizen/config.xml` copies the widget version from package.json and the Tizen
 * floor from scripts/compat-floor.mjs. A wrong floor would install the app on a
 * TV whose engine cannot render it. The release workflow rewrites the version
 * but never reads the floor, so neither drift shows in a CI artifact; this runs
 * in `npm test` and checks the source file every packaging path copies.
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

// Anchored to `<widget`, like stamp-manifest's regex: a bare /version="…"/ also
// matches `<tizen:application … version="4.0"` (the Tizen API level).
const widget = /<widget\b[^>]*>/.exec(xml)?.[0] || '';
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};

check('the manifest has a <widget> element', widget !== '', 'no <widget …> found');

check('the widget version matches package.json',
  attr(widget, 'version') === pkg.version,
  `manifest=${attr(widget, 'version')} package.json=${pkg.version}`);

// COMPAT_LABEL is "Tizen 6.5 (Chromium 94)"; the manifest wants just "6.5", on
// <tizen:application> rather than <widget>.
const floor = COMPAT_LABEL.match(/^Tizen (\d+(?:\.\d+)*)/)?.[1] || null;
const application = /<tizen:application\b[^>]*>/.exec(xml)?.[0] || '';
check('the compat floor is readable from COMPAT_LABEL', floor !== null, COMPAT_LABEL);
check('required_version matches the compat floor',
  attr(application, 'required_version') === floor,
  `manifest=${attr(application, 'required_version')} floor=${floor}`);

// `package` must be EXACTLY 10 characters: `tizen package` accepts anything,
// but the TV's security manager then fails at install time with
// `[118, -4] "Operation not allowed : Load archive info fail"`, which looks
// like a signing or Tizen-version problem. Only the package half is
// constrained, not the application-name half after the dot.
const packageId = attr(application, 'package');
const applicationId = attr(application, 'id');
check('the package id is exactly 10 characters',
  typeof packageId === 'string' && packageId.length === 10,
  `package=${packageId} (${packageId ? packageId.length : 0} chars)`);
check('the application id is namespaced by the package id',
  !!applicationId && !!packageId && applicationId.split('.')[0] === packageId,
  `application id=${applicationId} package=${packageId}`);

// Upstream shipped a placeholder; copying it through would bake someone else's
// domain into the widget.
const widgetId = attr(widget, 'id');
check('the widget id is not upstream\'s placeholder',
  !!widgetId && !/yourdomain/.test(widgetId), `widget id=${widgetId}`);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
