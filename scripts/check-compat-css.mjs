/**
 * CSS half of the compatibility floor check — the JS half is
 * `eslint --config eslint.compat.mjs src`.
 *
 * Runs doiuse over the built stylesheet at the engine version the Tizen
 * manifest declares, so a CSS feature newer than the floor fails here instead
 * of on a viewer's TV. Needs a build first: doiuse reads the emitted CSS, not
 * the source, because Lightning CSS rewrites and prefixes it on the way out.
 *
 * Two caveats worth knowing when this goes red:
 *  - doiuse has no `aspect-ratio` data (Chromium 88). A new use of it will
 *    pass this check; it is covered by the floor being 94, not by the tool.
 *  - `@font-face` blocks are blanked before the scan. doiuse's tokenizer stops
 *    the stream at the first one (declarations directly inside an at-rule
 *    have no selector to hang them on), which would silently skip every rule
 *    after it — the end of the bundle went unchecked until 2026-10-18. Blanking
 *    preserves byte offsets, so reported columns still point at the real rule.
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
 * Replace every `@font-face { … }` block with spaces of the same length.
 * The result has no `@font-face`, so doiuse parses all of it, and every other
 * rule keeps its original offset.
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

// Point the report back at dist/assets, and drop the tokenizer note that
// predates the blanking and is not a finding.
let output = `${result.stdout || ''}${result.stderr || ''}`
  .split('\n')
  .filter(line => line.trim() && !line.startsWith('[css-tokenize]'));
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
