#!/usr/bin/env node
/**
 * Guards the seam between scripts/compat-floor.mjs and vite.config.js.
 *
 * The floor is consumed in two spellings: doiuse and eslint-plugin-compat take
 * `chrome 94`, Vite's `build.target` takes `chrome94`. This imports the config
 * and compares the value the build actually uses, not a string in a comment.
 */

import config from '../vite.config.js';
import { COMPAT_TARGET, COMPAT_BUILD_TARGET } from './compat-floor.mjs';

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

const expected = COMPAT_TARGET.replace(/\s+/g, '');

check('build target is the esbuild spelling of the floor', COMPAT_BUILD_TARGET === expected, COMPAT_BUILD_TARGET);
check('build target has no whitespace', !/\s/.test(COMPAT_BUILD_TARGET), COMPAT_BUILD_TARGET);
check('vite builds for the compat floor', config.build?.target === COMPAT_BUILD_TARGET, String(config.build?.target));

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
