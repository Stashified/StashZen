#!/usr/bin/env node
/**
 * verify-mockart.mjs — the cover generator's decisions, checked as data.
 *
 *   node scripts/verify-mockart.mjs
 *
 * P6 changed `mockArt.js` from one palette and a handful of geometric marks to
 * a table of *regimes* with a few human-form motifs, and it is easy to write
 * that in a way where a regime is listed and never chosen, or a palette is
 * named `dark` and is not dark. Neither shows up in a casual look at the code,
 * and one of them — a regime nothing reaches — is invisible in a render too.
 *
 * So this checks the *plan*, not the picture:
 *
 *   1. `coverArt(seed)` is a pure function of its seed, proved two ways — twice
 *      in one process, and again against a freshly evaluated copy of the module,
 *      which is what a reload actually is. Module-level state would pass the
 *      first and fail the second.
 *   2. Nothing reaches for `Math.random` or `Date.now`. This is checked
 *      behaviourally: both are stubbed to throw, and `coverArt` is then called.
 *      A grep over the source would false-positive on the comments that discuss
 *      `Math.random()`, and would not catch an indirect call.
 *   3. No two of 200 seeds collide, on either canvas. The whole point of a Test
 *      cover is that no two cards are mistakable for one another.
 *   4. Every regime and every motif is *reachable*, and the weights have the
 *      shape the header claims: sweep the majority, warm a real minority, the
 *      three hard regimes present but rare.
 *   5. The adversarial regimes are actually adversarial — checked against the
 *      app's own background value, not against a round number.
 *
 * What this cannot check is whether any of it *looks* like a library. That is
 * `scripts/contact-sheet.mjs`, which renders one and also proves each cover is
 * well-formed XML, since rsvg-convert refuses to rasterise one that is not.
 *
 * Exits non-zero on the first failure, like the other verify scripts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { coverArt, artPlan } from '../src/utils/mockArt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', 'src', 'utils', 'mockArt.js');

let failed = 0;
let checks = 0;

function ok(label, cond, detail = '') {
  checks++;
  if (!cond) {
    failed++;
    console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${expected}\n        actual   ${actual}`);
}

// ── Hue and lightness out of an `hsl(H S% L%)` triple ─────
// The palettes return CSS colour strings, so the only way to assert that
// "dark" is dark is to read the number back out. Deliberately strict about the
// format: a palette that started emitting `rgb()` should fail here rather than
// silently make every check below vacuous.
function parseHsl(color) {
  const m = /^hsl\((\d+) ([\d.]+)% ([\d.]+)%\)$/.exec(color);
  if (!m) throw new Error(`not an hsl(H S% L%) triple: ${color}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

// The app's own page background, from src/index.css. `--bg-base: #202b33` is
// 16% lightness; the card surface `#30404d` is 24%. A cover is adversarial
// exactly when its ground has nothing to separate it from those.
const BG_BASE_LIGHTNESS = 16;

// ── 1. Purity ─────────────────────────────────────────────
console.log('\nPurity');

const SEEDS = Array.from({ length: 200 }, (_, i) => `scene-${i}`);

const first = SEEDS.map(s => coverArt(s));
eq('two calls in one process agree', coverArt('scene-0'), first[0]);

// A query string on the specifier makes Node evaluate the module again rather
// than hand back the cached one. That is the reload: any module-level counter,
// memo or lazily-built table shows up here and nowhere else.
const fresh = await import('../src/utils/mockArt.js?reload=1');
eq('a freshly evaluated module agrees', fresh.coverArt('scene-0'), first[0]);
eq('…including for a portrait cover',
  fresh.coverArt('performer-3', { portrait: true }), coverArt('performer-3', { portrait: true }));
eq('…and the plan is the same object shape',
  JSON.stringify(fresh.artPlan('tag-9', { portrait: true })),
  JSON.stringify(artPlan('tag-9', { portrait: true })));

// The plan is what everything else here asserts on, so it has to be as stable
// as the picture it describes.
eq('artPlan is pure too', JSON.stringify(artPlan('scene-7')), JSON.stringify(artPlan('scene-7')));

// ── 2. No randomness, no clock ────────────────────────────
console.log('\nNo hidden entropy');

{
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => { throw new Error('coverArt reached Math.random()'); };
  Date.now = () => { throw new Error('coverArt reached Date.now()'); };
  let threw = null;
  try {
    for (const s of ['scene-0', 'scene-11', 'tag-4']) {
      coverArt(s);
      coverArt(s, { portrait: true });
    }
  } catch (e) {
    threw = e.message;
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
  eq('coverArt uses neither Math.random nor Date.now', threw, null);
}

// ── 3. Distinctness ───────────────────────────────────────
console.log('\nDistinctness');

const unique = new Set(first);
eq('200 landscape seeds, 200 distinct covers', unique.size, 200);

const portrait = SEEDS.map(s => coverArt(s, { portrait: true }));
eq('200 portrait seeds, 200 distinct covers', new Set(portrait).size, 200);

ok('a portrait cover is not the landscape one for the same seed',
  coverArt('scene-0', { portrait: true }) !== coverArt('scene-0'));

// ── 4. Reachability and shape ─────────────────────────────
console.log('\nVocabulary');

// Enough seeds that a ~5% regime is sampled ~200 times — the bands below can
// then be tight without being flaky.
const SAMPLE = Array.from({ length: 4000 }, (_, i) => `s-${i}`);
const landscapePlans = SAMPLE.map(s => artPlan(s));
const portraitPlans = SAMPLE.map(s => artPlan(s, { portrait: true }));

const regimesSeen = new Set(landscapePlans.map(p => p.regime));
const LANDSCAPE_MOTIF_NAMES = [...new Set(landscapePlans.flatMap(p => p.motifs))].sort();
const PORTRAIT_MOTIF_NAMES = [...new Set(portraitPlans.flatMap(p => p.motifs))].sort();

// Named literally rather than imported: if a motif is renamed this list should
// have to be edited on purpose, rather than quietly following along.
const EXPECTED_LANDSCAPE = ['bands', 'blocks', 'bust', 'chevrons', 'dots', 'pair', 'rays', 'rings', 'waves', 'wedge'];
const EXPECTED_PORTRAIT = ['bands', 'figure', 'rings', 'torso', 'waves', 'wedge'];

eq('every landscape motif is reachable', LANDSCAPE_MOTIF_NAMES.join(','), EXPECTED_LANDSCAPE.join(','));
eq('every portrait motif is reachable', PORTRAIT_MOTIF_NAMES.join(','), EXPECTED_PORTRAIT.join(','));

// The human forms, on each canvas — P6's actual ask, and the one thing a
// "listed but never chosen" bug would quietly undo.
ok('a landscape cover can read as a person',
  ['bust', 'pair'].every(m => LANDSCAPE_MOTIF_NAMES.includes(m)));
ok('a portrait cover can read as a person',
  ['figure', 'torso'].every(m => PORTRAIT_MOTIF_NAMES.includes(m)));

const share = (name) =>
  landscapePlans.filter(p => p.regime === name).length / landscapePlans.length;

for (const name of ['sweep', 'warm', 'dark', 'blown', 'clutter']) {
  ok(`the ${name} regime is reachable`, regimesSeen.has(name));
}
eq('and nothing else is', [...regimesSeen].sort().join(','), 'blown,clutter,dark,sweep,warm');

// The shape, not the numbers. The weights are the author's claim about what a
// library looks like and are meant to be tunable; what must not drift is that
// the ordinary case dominates and the hard cases stay rare.
console.log('\nWeights (share of 4000 seeds)');
for (const name of ['sweep', 'warm', 'dark', 'blown', 'clutter']) {
  console.log(`  ${name.padEnd(8)} ${(share(name) * 100).toFixed(1)}%`);
}

ok('the sweep is the majority', share('sweep') > 0.45 && share('sweep') < 0.70,
  `sweep is ${(share('sweep') * 100).toFixed(1)}%`);
ok('warm is a real minority', share('warm') > 0.18 && share('warm') < 0.40,
  `warm is ${(share('warm') * 100).toFixed(1)}%`);
const hard = share('dark') + share('blown') + share('clutter');
ok('the hard regimes are rare but present', hard > 0.05 && hard < 0.25,
  `dark+blown+clutter is ${(hard * 100).toFixed(1)}%`);
for (const name of ['dark', 'blown', 'clutter']) {
  ok(`${name} is not vanishingly rare`, share(name) > 0.015,
    `${name} is ${(share(name) * 100).toFixed(2)}%`);
}

// The clutter regime exists to be *busy*, so the regime has to be what decides
// the number of motifs — a field that is set and never read would pass every
// check above.
const clutterPlans = landscapePlans.filter(p => p.regime === 'clutter');
ok('clutter draws three motifs', clutterPlans.every(p => p.motifs.length === 3));
ok('every other regime draws exactly one',
  landscapePlans.filter(p => p.regime !== 'clutter').every(p => p.motifs.length === 1));

// ── 5. The hard regimes are actually hard ─────────────────
console.log('\nAre the hard regimes hard?');

const ground = (p) => parseHsl(p.colors.bgA);

const darkGrounds = landscapePlans.filter(p => p.regime === 'dark').map(ground);
ok('dark grounds are below the page background',
  darkGrounds.every(g => g.l < BG_BASE_LIGHTNESS),
  `worst ${Math.max(...darkGrounds.map(g => g.l))}% vs --bg-base ${BG_BASE_LIGHTNESS}%`);

const blownGrounds = landscapePlans.filter(p => p.regime === 'blown').map(ground);
ok('blown grounds are above 70% lightness',
  blownGrounds.every(g => g.l > 70),
  `darkest ${Math.min(...blownGrounds.map(g => g.l))}%`);
ok('blown grounds are desaturated, like a real overexposure',
  blownGrounds.every(g => g.s < 25),
  `most saturated ${Math.max(...blownGrounds.map(g => g.s))}%`);

const warmGrounds = landscapePlans.filter(p => p.regime === 'warm').map(ground);
ok('warm grounds sit in the skin-and-ember arc',
  warmGrounds.every(g => g.h >= 8 && g.h <= 40),
  `hues ${Math.min(...warmGrounds.map(g => g.h))}–${Math.max(...warmGrounds.map(g => g.h))}`);
ok('warm grounds are low-key',
  warmGrounds.every(g => g.l <= 26),
  `lightest ${Math.max(...warmGrounds.map(g => g.l))}%`);

// The other half of the warm case: one *lit* subject on that dark ground, so
// the mark has to be well above it. Without this the regime is just "dim".
const warmLit = landscapePlans.filter(p => p.regime === 'warm')
  .map(p => parseHsl(p.colors.stroke).l - parseHsl(p.colors.bgA).l);
ok('warm covers have one lit subject', Math.min(...warmLit) > 25,
  `smallest ground-to-mark gap ${Math.min(...warmLit).toFixed(0)}%`);

const clutterGrounds = landscapePlans.filter(p => p.regime === 'clutter').map(ground);
ok('clutter grounds are mid and desaturated, so the marks merge',
  clutterGrounds.every(g => g.l > 25 && g.l < 45 && g.s < 26),
  `lightness ${Math.min(...clutterGrounds.map(g => g.l))}–${Math.max(...clutterGrounds.map(g => g.l))}%,`
  + ` saturation to ${Math.max(...clutterGrounds.map(g => g.s))}%`);

// ── 6. The emitted document ───────────────────────────────
console.log('\nThe emitted document');

{
  const svg = decodeURIComponent(coverArt('scene-0').replace('data:image/svg+xml,', ''));
  ok('is an SVG data URI', coverArt('scene-0').startsWith('data:image/svg+xml,'));
  ok('decodes to a complete svg element', svg.startsWith('<svg ') && svg.endsWith('</svg>'));
  ok('is sized for the landscape canvas', svg.includes('width="640" height="360"'));
  ok('and the ground fills it', svg.includes('<rect width="640" height="360" fill="url(#g)"/>'));

  const tall = decodeURIComponent(coverArt('x', { portrait: true }).replace('data:image/svg+xml,', ''));
  ok('the portrait canvas is the taller one', tall.includes('width="400" height="600"'));

  // Not blank: everything after the ground rect is the motif. 80 characters is
  // far below the smallest of them (rings, at four circles) and far above
  // nothing at all.
  const marks = svg.slice(svg.indexOf('fill="url(#g)"/>') + 17);
  ok('and there is something drawn on it', marks.length > 80, `${marks.length} chars of motif`);
}

// ── 7. The source has not grown new vocabulary ────────────
// A cheap guard against a palette or motif being added as a local helper and
// never being wired into REGIMES or the motif arrays — which is the failure
// mode this whole file exists for, and the only one the checks above cannot
// see directly.
{
  const src = readFileSync(SOURCE, 'utf8');
  const declared = [...src.matchAll(/^function ([a-zA-Z]+)\(/gm)].map(m => m[1]);
  const wiring = src.slice(src.indexOf('const LANDSCAPE_MOTIFS'));
  const unwired = declared.filter(name => !wiring.includes(name) && name !== 'pickRegime');
  ok('every motif and palette function is wired into a table',
    unwired.length === 0, `unreferenced: ${unwired.join(', ')}`);
}

// ── Summary ───────────────────────────────────────────────
console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log('The picture itself is not checked here — that is scripts/contact-sheet.mjs.');
