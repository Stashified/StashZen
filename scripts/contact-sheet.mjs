#!/usr/bin/env node
/**
 * contact-sheet.mjs — render Test mode's covers as one image, and look at it.
 *
 *   node scripts/contact-sheet.mjs                 # scene-0 … scene-47
 *   node scripts/contact-sheet.mjs --portrait      # performer-*, taller tiles
 *   node scripts/contact-sheet.mjs --seed tag- --count 24 --out /tmp/tags.png
 *   node scripts/contact-sheet.mjs --only warm     # one regime only
 *
 * `verify-mockart.mjs` proves the *decisions* — that every regime is reachable,
 * that `dark` is dark, that the same seed always draws the same picture. It
 * cannot tell you whether the result reads as a library rather than as a
 * different set of abstract shapes, because that is not a property of the
 * numbers. This is the other half, and it is meant to be looked at: it writes a
 * PNG, and the point is to open it.
 *
 * How it works, and why this way. A cover is an SVG data URI, and the obvious
 * thing — inline forty-eight of them into one big SVG — is wrong: every cover
 * names its gradient `id="g"`, which is harmless when each is its own document
 * and a collision the moment they share one, so every tile after the first
 * would silently take the first tile's colours. Each tile is therefore
 * rasterised on its own and montaged, which also means **every cover is parsed
 * by a real XML parser**: rsvg-convert refuses a malformed document, so a
 * generator that emitted broken markup fails here loudly instead of producing a
 * sheet with a blank tile in it.
 *
 * The labels are the filename, which is built from the plan: `07_warm-recline`
 * is seed seven, the warm regime, the recline motif. That is the whole reason
 * `artPlan` is exported — a sheet you cannot read the decisions off is a
 * decoration.
 *
 * Needs `rsvg-convert` (librsvg) and `magick` (ImageMagick 7) on PATH.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { artPlan, coverArt } from '../src/utils/mockArt.js';

// ── Arguments ─────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    seed: 'scene-',
    count: 48,
    portrait: false,
    only: null,
    out: '/tmp/contact-sheet.png',
    cols: 8,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--portrait') opts.portrait = true;
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--count') opts.count = Number(argv[++i]);
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--cols') opts.cols = Number(argv[++i]);
    else {
      console.error(`unknown argument: ${a}\nSee the header of this file.`);
      process.exit(2);
    }
  }
  // A portrait sheet is 2:3, so the same column count would make it enormous.
  if (argv.includes('--portrait') && !argv.includes('--cols')) opts.cols = 8;
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ── Plan, then draw ───────────────────────────────────────
const WORK = '/tmp/contact-sheet';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// Regimes are ~5% each, so a 48-tile sheet shows two or three of each at most
// and may miss one entirely. `--only` is how a hard case gets a sheet of its
// own rather than being hunted for; the seed range is walked further so there
// is enough of them to fill a row.
const wanted = opts.only ? Math.ceil(opts.count / 0.05) + 200 : opts.count;
const tiles = [];
for (let i = 0; ; i += 1) {
  if (tiles.length >= opts.count || i >= wanted) break;
  const seed = `${opts.seed}${i}`;
  const plan = artPlan(seed, { portrait: opts.portrait });
  if (opts.only && plan.regime !== opts.only) continue;
  tiles.push({ seed, plan });
}

if (tiles.length === 0) {
  console.error(`no seed under "${opts.seed}" lands on the ${opts.only} regime`);
  process.exit(1);
}

const files = [];
for (const [i, tile] of tiles.entries()) {
  const label = `${String(i).padStart(2, '0')}_${tile.plan.regime}-${tile.plan.motifs.join('+')}`;
  const svgPath = `${WORK}/${label}.svg`;
  const pngPath = `${WORK}/${label}.png`;
  writeFileSync(svgPath, decodeURIComponent(
    coverArt(tile.seed, { portrait: opts.portrait }).replace('data:image/svg+xml,', '')));
  try {
    execFileSync('rsvg-convert', ['-o', pngPath, svgPath], { stdio: 'pipe' });
  } catch (e) {
    // The parser is the point: a cover that is not well-formed XML fails here
    // rather than appearing as a blank tile in a sheet somebody is reading.
    console.error(`rsvg-convert refused ${label}.svg — the cover is not valid SVG:`);
    console.error(String(e.stderr || e.message).trim());
    process.exit(1);
  }
  files.push(pngPath);
}

// ── Montage ───────────────────────────────────────────────
const tileW = opts.portrait ? 150 : 200;
const tileH = Math.round(tileW * (opts.portrait ? 1.5 : 0.5625));

execFileSync('magick', [
  'montage',
  '-label', '%t',
  ...files,
  '-tile', `${opts.cols}x`,
  '-geometry', `${tileW}x${tileH}+5+5`,
  '-background', '#202b33',   // --bg-base, so the sheet is read against the
  '-fill', '#f5f8fa',         // real page colour and the real text colour
  '-pointsize', '12',
  '-font', 'DejaVu-Sans',
  opts.out,
], { stdio: 'inherit' });

// ── Report ────────────────────────────────────────────────
const counts = {};
for (const t of tiles) counts[t.plan.regime] = (counts[t.plan.regime] ?? 0) + 1;
const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');

console.log(`\n${files.length} tiles (${opts.portrait ? 'portrait' : 'landscape'}) → ${opts.out}`);
console.log(`  ${summary}`);
console.log(`  ${readdirSync(WORK).length / 2} source SVGs kept in ${WORK}`);
