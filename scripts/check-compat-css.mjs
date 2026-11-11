/**
 * CSS half of the compatibility floor check, the JS half is
 * `eslint --config eslint.compat.mjs src`.
 *
 * Runs doiuse over the built stylesheet at the engine version the Tizen
 * manifest declares, so CSS newer than the floor fails here rather than on a
 * viewer's TV. Needs a build: doiuse reads the emitted CSS, not the source,
 * because Lightning CSS rewrites and prefixes it.
 *
 * Three caveats:
 *  - doiuse has no `aspect-ratio` data (Chromium 88), so a new use passes; the
 *    floor of 94 covers it, not the tool.
 *  - `@font-face` blocks are blanked before the scan: doiuse's tokenizer stops
 *    at the first one (declarations inside an at-rule have no selector), which
 *    silently skips every rule after it. Blanking preserves byte offsets, so
 *    reported columns still point at the real rule.
 *  - doiuse has no `contain-intrinsic-size` data either, so the fallback pair is
 *    asserted here by hand: Chromium 94 drops `auto <length>` whole, and the
 *    minifier is free to merge the two declarations into it.
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

// Run doiuse's own entry script through this Node binary rather than the
// node_modules/.bin shim: hardened Node refuses to spawn a Windows .cmd without
// a shell (CVE-2024-27980), and a shell would need quoting for temp paths that
// can contain spaces. Resolved before the temp dir exists, so a missing install
// exits without leaving one behind.
const doiusePkgPath = path.join(root, 'node_modules', 'doiuse', 'package.json');
if (!existsSync(doiusePkgPath)) {
  console.error('doiuse is not installed: run `npm install` first, then retry.');
  process.exit(1);
}
const doiusePkg = JSON.parse(readFileSync(doiusePkgPath, 'utf8'));
const doiuseBin = typeof doiusePkg.bin === 'string'
  ? doiusePkg.bin
  : (doiusePkg.bin?.doiuse ?? Object.values(doiusePkg.bin ?? {})[0]);
if (!doiuseBin) {
  console.error('doiuse package.json has no bin entry; reinstalling the dependency may fix it.');
  process.exit(1);
}
const doiuseCli = path.join(root, 'node_modules', 'doiuse', doiuseBin);
const baseArgs = ['--browsers', COMPAT_TARGET, '--ignore', COMPAT_CSS_IGNORES.join(',')];

// doiuse needs complete files, so the blanked copies go in a temp dir. Findings
// name that path and its columns; columns still match the original bundle.
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'stashzen-compat-'));
const scanned = cssFiles.map(name => {
  const source = path.join(assets, name);
  const copy = path.join(tempDir, name);
  writeFileSync(copy, blankFontFaces(readFileSync(source, 'utf8')));
  return { name, source, copy };
});

// One process per file. doiuse's CLI pipes every input into one shared output
// stream and ends it when the first input finishes, so a single run drops the
// findings of files still being parsed. main-*.css is last in readdir order,
// and its tail went unscanned while the check still reported success.
const findings = [];
let scanError = null;
for (const file of scanned) {
  const result = spawnSync(process.execPath, [doiuseCli, ...baseArgs, file.copy], { encoding: 'utf8' });
  if (result.error) {
    scanError = [`Could not run doiuse: ${result.error.message}`];
    break;
  }
  // doiuse exits 0 even when it reports features (the findings are the
  // report), so a non-zero status means the tool itself did not finish.
  if (result.status !== 0) {
    scanError = [`doiuse exited with status ${result.status}; the CSS scan did not complete.`];
    if (result.stdout) scanError.push(result.stdout);
    if (result.stderr) scanError.push(result.stderr);
    break;
  }

  const lines = `${result.stdout || ''}${result.stderr || ''}`
    .split('\n')
    .filter(line => line.trim());

  // A tokenizer note means doiuse stopped parsing this file, so every rule
  // after it went unscanned. Filtering it as noise turns a partial scan into a
  // green check; a healthy bundle has no such note, so any is a failure.
  const tokenizerNotes = lines.filter(line => line.startsWith('[css-tokenize]'));
  if (tokenizerNotes.length) {
    scanError = [
      ...tokenizerNotes,
      'CSS: doiuse could not tokenize the built stylesheet; the scan is incomplete.',
    ];
    break;
  }

  // Point the report back at dist/assets.
  const source = path.relative(root, file.source);
  for (const line of lines) findings.push(line.split(file.copy).join(source));
}

rmSync(tempDir, { recursive: true, force: true });

if (scanError) {
  for (const line of scanError) console.error(line);
  process.exit(1);
}

/**
 * Every `contain-intrinsic-size: auto <length>` needs the bare-length form
 * earlier in the same rule. The floor engine cannot parse `auto <length>` and
 * drops the declaration, so without the pair the placeholder size is simply
 * unset there, and the grid reflows as cards scroll in. Lightning CSS may merge
 * the pair, which is exactly the failure this catches.
 */
function intrinsicSizeFallbacks(css, label) {
  const failures = [];
  const declaration = /contain-intrinsic-size\s*:\s*([^;}]*)/g;
  for (let match = declaration.exec(css); match; match = declaration.exec(css)) {
    const value = match[1].trim();
    if (!/^auto\b/.test(value)) continue;
    // The rule this declaration sits in: everything after its opening brace
    // and before the declaration. Nested blocks are fine, the fallback must
    // still be in the same declared rule.
    const ruleStart = css.lastIndexOf('{', match.index);
    const earlier = css.slice(ruleStart + 1, match.index);
    if (/contain-intrinsic-size\s*:\s*(?!auto\b)[^;}]*/.test(earlier)) continue;
    const line = css.slice(0, match.index).split('\n').length;
    failures.push(`${label}:${line} has "contain-intrinsic-size: ${value}" with no bare-length fallback in the same rule`);
  }
  return failures;
}

const structural = cssFiles.flatMap(name => intrinsicSizeFallbacks(
  readFileSync(path.join(assets, name), 'utf8'),
  path.relative(root, path.join(assets, name)),
));

for (const line of [...findings, ...structural]) console.error(line);

if (findings.length === 0 && structural.length === 0) {
  console.log(`CSS: no findings at ${COMPAT_LABEL}.`);
  process.exit(0);
}

if (findings.length) {
  console.error(`\nCSS uses features newer than ${COMPAT_LABEL} (${findings.length} finding${findings.length === 1 ? '' : 's'}).`);
}
if (structural.length) {
  console.error(`\nCSS: ${structural.length} fallback-pair finding${structural.length === 1 ? '' : 's'} at ${COMPAT_LABEL}.`);
}
process.exit(1);
