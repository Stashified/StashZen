#!/usr/bin/env node
/**
 * contact-sheet.mjs: render Test mode's covers as one image, and look at it.
 *
 *   node scripts/contact-sheet.mjs                 # scene-0 … scene-47
 *   node scripts/contact-sheet.mjs --portrait      # performer-*, taller tiles
 *   node scripts/contact-sheet.mjs --seed tag- --count 24 --out /tmp/tags.png
 *   node scripts/contact-sheet.mjs --only warm     # one regime only
 *
 * `verify-mockart.mjs` proves the decisions (regime reachability, darkness,
 * seed stability) but not whether the result reads as a library. This writes a
 * PNG meant to be opened.
 *
 * Every cover names its gradient `id="g"`, so inlining them into one SVG would
 * make every tile take the first tile's colours. Tiles are rasterised one at a
 * time and montaged; rsvg-convert also rejects malformed SVG, so a broken
 * generator fails loudly instead of producing a blank tile.
 *
 * Labels encode the plan: `07_warm-recline` is seed seven, the warm regime, the
 * recline motif. That is why `artPlan` is exported.
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
  // A portrait tile is 2:3, so the same column count would make it enormous.
  if (argv.includes('--portrait') && !argv.includes('--cols')) opts.cols = 8;
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ── Plan, then draw ───────────────────────────────────────
const WORK = '/tmp/contact-sheet';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// Regimes are ~5% each, so a 48-tile sheet shows two or three of each and may
// miss one. `--only` gives a hard case its own sheet; walk further so there are
// enough tiles to fill a row.
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
  '-background', '#202b33',   // --bg-base: read tiles against the real page
  '-fill', '#f5f8fa',         // colour and the real text colour
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
