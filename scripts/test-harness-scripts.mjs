#!/usr/bin/env node
/**
 * test-harness-scripts.mjs: the shell harness's guards, without running a
 * sweep.
 *
 *   node scripts/test-harness-scripts.mjs
 *
 * Only the label check is covered: it protects a recursive `rm -rf`, and a
 * regression there is destructive rather than a red check.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP = join(ROOT, 'scripts/harness/sweep.sh');

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

function run(label) {
  return spawnSync('bash', [SWEEP, label], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

for (const label of ['..', '.', 'a/b', 'has space', '$HOME']) {
  const r = run(label);
  check(`sweep.sh refuses the label "${label}"`,
    r.status === 2 && /invalid label/.test(r.stderr),
    `status=${r.status} stderr=${JSON.stringify(r.stderr.trim())}`);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
