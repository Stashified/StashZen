/**
 * CSS half of the compatibility floor check — the JS half is
 * `eslint --config eslint.compat.mjs src`.
 *
 * Runs doiuse over the built stylesheet at the engine version the Tizen
 * manifest declares, so CSS newer than the floor fails here rather than on a
 * viewer's TV. Needs a build: doiuse reads the emitted CSS, not the source,
 * because Lightning CSS rewrites and prefixes it.
 *
 * Two caveats:
 *  - doiuse has no `aspect-ratio` data (Chromium 88), so a new use passes; the
 *    floor of 94 covers it, not the tool.
 *  - `@font-face` blocks are blanked before the scan: doiuse's tokenizer stops
 *    at the first one (declarations inside an at-rule have no selector), which
 *    silently skips every rule after it. Blanking preserves byte offsets, so
 *    reported columns still point at the real rule.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPAT_CSS_IGNORES, COMPAT_LABEL, COMPAT_TARGET } from './compat-floor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'dist', 'assets');

if (!existsSync(assets)) {
  console.error('No dist/assets — run `npm run build` first, then retry.');
  process.exit(1);
}

const cssFiles = readdirSync(assets).filter(name => name.endsWith('.css'));

if (cssFiles.length === 0) {
  console.error('dist/assets holds no CSS — run `npm run build` first, then retry.');
  process.exit(1);
}

/**
 * Replace every `@font-face { … }` block with spaces of the same length, so
 * doiuse parses the whole file and every other rule keeps its offset.
 */
function blankFontFaces(css) {
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = css.indexOf('@font-face', cursor);
    if (start === -1) {
      out += css.slice(cursor);
      return out;
    }
    const open = css.indexOf('{', start);
    if (open === -1) {
      out += css.slice(cursor);
      return out;
    }
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const block = css.slice(start, end + 1);
    out += css.slice(cursor, start) + ' '.repeat(block.length);
    cursor = end + 1;
  }
}

// doiuse needs complete files, so the blanked copies go in a temp dir. Findings
// name that path and its columns; columns still match the original bundle.
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'stashzen-compat-'));
const scanned = cssFiles.map(name => {
  const source = path.join(assets, name);
  const copy = path.join(tempDir, name);
  writeFileSync(copy, blankFontFaces(readFileSync(source, 'utf8')));
  return { name, source, copy };
});

const binary = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'doiuse.cmd' : 'doiuse');
const result = spawnSync(
  binary,
  ['--browsers', COMPAT_TARGET, '--ignore', COMPAT_CSS_IGNORES.join(','), ...scanned.map(file => file.copy)],
  { encoding: 'utf8' },
);

rmSync(tempDir, { recursive: true, force: true });

if (result.error) {
  console.error(`Could not run doiuse: ${result.error.message}`);
  process.exit(1);
}
// doiuse exits 0 even when it reports features (the findings are the report),
// so a non-zero status means the tool itself did not finish.
if (result.status !== 0) {
  console.error(`doiuse exited with status ${result.status}; the CSS scan did not complete.`);
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

const lines = `${result.stdout || ''}${result.stderr || ''}`
  .split('\n')
  .filter(line => line.trim());

// A tokenizer note means doiuse stopped parsing part of the bundle, so every
// rule after it went unscanned. Filtering it as noise turns a partial scan into
// a green check; a healthy bundle has no such note, so any is a failure.
const tokenizerNotes = lines.filter(line => line.startsWith('[css-tokenize]'));
if (tokenizerNotes.length) {
  for (const line of tokenizerNotes) console.error(line);
  console.error('CSS: doiuse could not tokenize the built stylesheet; the scan is incomplete.');
  process.exit(1);
}

// Point the report back at dist/assets.
let output = lines;
for (const file of scanned) {
  output = output.map(line => line.split(file.copy).join(path.relative(root, file.source)));
}
const findings = output;

for (const line of findings) console.error(line);

if (findings.length === 0) {
  console.log(`CSS: no findings at ${COMPAT_LABEL}.`);
  process.exit(0);
}

console.error(`\nCSS uses features newer than ${COMPAT_LABEL} (${findings.length} finding${findings.length === 1 ? '' : 's'}).`);
process.exit(1);
