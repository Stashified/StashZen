/**
 * mockArt.js: the covers Test mode draws for itself.
 *
 * SVG data URIs derived from the item's own id: deterministic (same id, same
 * picture every load), offline, and distinct enough that no two cards are
 * mistaken for one another. A third-party stock-photo URL would put Test mode
 * online, report usage elsewhere, and reshuffle on every reload.
 *
 * ── Regimes ────────────────────────────────────────────────────────────────
 *
 * One mid-lightness hue sweep makes 48 tiles distinguishable but is a poor
 * model of a real library, which is warm, skin-tone-dominant and low-key, one
 * lit subject on a dark field. The UI must be tested against the covers most
 * likely to break it: white chrome, the 40% black scrim on a focused card
 * (`VideoCard.module.css`) and a blue focus ring, over a tile close in value to
 * `--bg-base` (#202b33).
 *
 * So the palette is chosen per seed from a small table of regimes, with a
 * deliberate minority landing on adversarial ones. The weights live in
 * `REGIMES` and are meant to be tuned from the contact sheet;
 * `scripts/verify-mockart.mjs` asserts only their rough shape, the sweep stays
 * the majority, the hard regimes stay rare, so none becomes the whole library
 * or dead code.
 *
 *   sweep     old behaviour          ~57%   ordinary, well-behaved hue sweep
 *   warm      dark, skin-toned       ~29%   one lit subject on a dark field
 *   dark      near-black             ~5%    the tile dissolves into the page
 *   blown     near-white             ~5%    white chrome and the scrim vanish
 *   clutter   three motifs at once   ~5%    the focus ring has nothing to sit on
 *
 * A Test-mode screen now reads as an adult library, so a screenshot is no
 * longer a neutral artefact; a few tiles look like a failed load, which is the
 * near-black regime working as designed.
 *
 * ── Determinism is load-bearing ────────────────────────────────────────────
 *
 * Differential diffs rest on `coverArt(seed)` being a pure function of its
 * seed, so all vocabulary is drawn through `makeRng`, no `Math.random()`, no
 * clock, and `scripts/verify-mockart.mjs` proves it by stubbing both to throw
 * and calling `coverArt`.
 *
 * It stays SVG, so it stays abstract: real imagery in a data URI would mean
 * committing adult content as source. Procedural suggestion is the version that
 * can live in the repo.
 */

/** FNV-1a, 32-bit. Any stable hash would do; this one is four lines, no deps. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32, a deterministic PRNG, so a seeded id always yields the same
 * numbers. Do not swap in xorshift32: its low bits are weakly decorrelated, so
 * nearby seeds make hue and motif track each other. Independent streams
 * (`seed|p` palette, `seed|m` motif, `|r` regime) are the other half; see
 * `planArt`.
 */
export function makeRng(seed) {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Motifs ───────────────────────────────────────────────
// Each draws into a width×height box with the palette it is handed and returns
// SVG markup. A cover must be *recognisably itself* at 200px across the room,
// so the marks are large and few.

const n = (v, dp = 0) => Number(v).toFixed(dp);

function rings(rng, w, h, stroke) {
  const cx = w * (0.2 + rng() * 0.6);
  const cy = h * (0.25 + rng() * 0.5);
  const unit = Math.min(w, h);
  let out = '';
  for (let i = 1; i <= 4; i += 1) {
    out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(unit * i * 0.12)}"`
        + ` fill="none" stroke="${stroke}" stroke-width="${n(2 + rng() * 3, 1)}"`
        + ` opacity="${n(0.8 - i * 0.12, 2)}"/>`;
  }
  return out;
}

function bands(rng, w, h, stroke) {
  const band = h * (0.08 + rng() * 0.1);
  const gap = h * (0.12 + rng() * 0.12);
  let out = '';
  // Offset by a fraction of the *gap*, not canvas × gap: the latter puts the
  // first band thousands of pixels down and the loop never runs. Starting
  // slightly above the top keeps the first band off the edge, not clipped.
  for (let y = rng() * gap - band; y < h; y += band + gap) {
    out += `<rect x="0" y="${n(y)}" width="${n(w)}" height="${n(band)}"`
        + ` fill="${stroke}" opacity="${n(0.14 + rng() * 0.25, 2)}"/>`;
  }
  return out;
}

function dots(rng, w, h, stroke) {
  const cols = 5 + Math.floor(rng() * 4);
  const rows = Math.max(3, Math.round(cols * (h / w)));
  const r = Math.min(w / cols, h / rows) * 0.32;
  let out = '';
  for (let c = 0; c < cols; c += 1) {
    for (let rw = 0; rw < rows; rw += 1) {
      const scale = 0.55 + rng() * 0.75;
      out += `<circle cx="${n((c + 0.5) * (w / cols))}" cy="${n((rw + 0.5) * (h / rows))}"`
          + ` r="${n(r * scale, 1)}" fill="${stroke}" opacity="${n(0.45 + rng() * 0.45, 2)}"/>`;
    }
  }
  return out;
}

/** A single diagonal edge with the far side filled, the plainest possible
 *  composition, and useful precisely because it reads at any size. */
function wedge(rng, w, h, stroke) {
  const x = w * (0.3 + rng() * 0.4);
  return `<path d="M ${n(x)} 0 L ${n(w)} 0 L ${n(w)} ${n(h)} L ${n(x + w * 0.2)} ${n(h)} Z"`
       + ` fill="${stroke}" opacity="${n(0.3 + rng() * 0.25, 2)}"/>`;
}

function waves(rng, w, h, stroke) {
  const lines = 4 + Math.floor(rng() * 3);
  const amp = h * (0.05 + rng() * 0.08);
  let out = '';
  for (let i = 0; i < lines; i += 1) {
    const base = h * ((i + 1) / (lines + 1));
    const d = `M 0 ${n(base)} Q ${n(w * 0.25)} ${n(base - amp)}, ${n(w * 0.5)} ${n(base)}`
            + ` T ${n(w)} ${n(base)}`;
    out += `<path d="${d}" fill="none" stroke="${stroke}"`
        + ` stroke-width="${n(1.5 + rng() * 2.5, 1)}" opacity="${n(0.35 + rng() * 0.4, 2)}"/>`;
  }
  return out;
}

function chevrons(rng, w, h, stroke) {
  const cols = 4 + Math.floor(rng() * 4);
  const step = w / cols;
  let out = '';
  for (let i = 0; i < cols; i += 1) {
    const x = i * step + step * 0.2;
    const d = `M ${n(x)} ${n(h * 0.22)} L ${n(x + step * 0.3)} ${n(h * 0.5)}`
            + ` L ${n(x)} ${n(h * 0.78)}`;
    out += `<path d="${d}" fill="none" stroke="${stroke}"`
        + ` stroke-width="${n(3 + rng() * 4, 1)}" stroke-linecap="round"`
        + ` opacity="${n(0.35 + rng() * 0.45, 2)}"/>`;
  }
  return out;
}

function blocks(rng, w, h, stroke) {
  let out = '';
  for (let i = 0; i < 5; i += 1) {
    const bw = w * (0.12 + rng() * 0.3);
    const bh = h * (0.12 + rng() * 0.4);
    out += `<rect x="${n(rng() * (w - bw))}" y="${n(rng() * (h - bh))}"`
        + ` width="${n(bw)}" height="${n(bh)}" fill="${stroke}"`
        + ` opacity="${n(0.18 + rng() * 0.4, 2)}"/>`;
  }
  return out;
}

function rays(rng, w, h, stroke) {
  const cx = w * 0.5;
  const cy = h * (0.35 + rng() * 0.4);
  const spread = Math.PI * (0.25 + rng() * 0.5);
  let out = '';
  for (let i = 0; i < 9; i += 1) {
    const a = -spread / 2 + (spread * i) / 8;
    out += `<line x1="${n(cx)}" y1="${n(cy)}"`
        + ` x2="${n(cx + Math.sin(a) * w)}" y2="${n(cy - Math.cos(a) * h)}"`
        + ` stroke="${stroke}" stroke-width="${n(2 + rng() * 5, 1)}"`
        + ` opacity="${n(0.2 + rng() * 0.35, 2)}"/>`;
  }
  return out;
}

// ── Human forms ──────────────────────────────────────────
// Three motifs draw a person: the same silhouette at different proportions,
// so the arithmetic is written once.

/**
 * Head and shoulders, with the shoulders actually meeting the chin.
 *
 * A quadratic only reaches *halfway* to its control point, so a control near
 * the chin drops the dome apex ~150px and reads as a sun over a hill. The apex
 * of Q(P0, C, P2) with endpoints at y = base is 0.5·base + 0.5·Cy, hence
 * Cy = 2·chin − base (negative is fine: only t ≈ 0.5 is drawn).
 *
 * Meeting exactly is not enough: the shapes become tangent, the neck zero-width,
 * and at 200px it reads as a ball on a hill. Sinking the apex by `NECK·headR`
 * gives a real join width, the circle there spans
 * `2·headR·√(2·NECK − NECK²)`, a little over half the head at 0.22.
 *
 * `shoulder` is a half-width, so the shape spans 2·shoulder.
 */
const NECK = 0.22;

// `fade` exists for `pair`: the far figure is the same silhouette at reduced
// opacity, so the composition reads as two people, not one wide person.

function silhouette(cx, headY, headR, shoulder, base, stroke, fade = 1) {
  const chin = headY + headR;
  const control = 2 * (chin - headR * NECK) - base;
  return `<path d="M ${n(cx - shoulder)} ${n(base)}`
       + ` Q ${n(cx)} ${n(control)} ${n(cx + shoulder)} ${n(base)} Z"`
       + ` fill="${stroke}" opacity="${n(0.45 * fade, 2)}"/>`
       + `<circle cx="${n(cx)}" cy="${n(headY)}" r="${n(headR)}"`
       + ` fill="${stroke}" opacity="${n(0.8 * fade, 2)}"/>`;
}

/** Portrait: a person standing, shoulders running off the bottom edge. Sized
 *  off the width so it fills the frame rather than sitting in it. */
function figure(rng, w, h, stroke) {
  const cx = w * (0.42 + rng() * 0.16);
  const headR = w * (0.17 + rng() * 0.05);
  const headY = h * (0.3 + rng() * 0.06);
  const shoulder = headR * (2.1 + rng() * 0.4);
  return silhouette(cx, headY, headR, shoulder, h, stroke);
}

/** Portrait: a tighter crop than `figure`, larger head, shoulders wider than
 *  the frame, so it reads as a close-up at 200px, the only size that matters. */
function torso(rng, w, h, stroke) {
  const cx = w * (0.36 + rng() * 0.28);
  const headR = w * (0.25 + rng() * 0.07);
  const headY = h * (0.22 + rng() * 0.08);
  const shoulder = w * (0.72 + rng() * 0.2);
  return silhouette(cx, headY, headR, shoulder, h, stroke);
}

/** Landscape: the same silhouette, sized off the *height*. A head sized off a
 *  16:9 canvas's width fills it top to bottom and reads as a portrait crop. */
function bust(rng, w, h, stroke) {
  const cx = w * (0.34 + rng() * 0.32);
  const headR = h * (0.15 + rng() * 0.06);
  const headY = h * (0.3 + rng() * 0.1);
  const shoulder = headR * (2.6 + rng() * 0.8);
  return silhouette(cx, headY, headR, shoulder, h, stroke);
}

/** Landscape: two figures at different scales and opacities, the far `fade`
 *  stopping them reading as one oddly wide person. A reclining figure was tried
 *  twice and read as a rolling pin: a silhouette has no interior detail to say
 *  "person", so a body lying down is just a long rounded rectangle, while two
 *  upright ones are unmistakable at 200px. */
function pair(rng, w, h, stroke) {
  const farR = h * (0.13 + rng() * 0.03);
  const farY = h * (0.42 + rng() * 0.08);
  const farX = w * (0.24 + rng() * 0.12);
  const nearR = h * (0.18 + rng() * 0.05);
  const nearY = h * (0.3 + rng() * 0.08);
  const nearX = w * (0.56 + rng() * 0.16);
  return silhouette(farX, farY, farR, farR * (2.3 + rng() * 0.5), h, stroke, 0.55)
       + silhouette(nearX, nearY, nearR, nearR * (2.3 + rng() * 0.5), h, stroke);
}

// Named objects rather than bare functions so a plan can be reported and
// asserted by name: a property name survives minification, a bare function's
// `.name` does not, and these must be readable in a production build.
const LANDSCAPE_MOTIFS = [
  { name: 'rings', draw: rings },
  { name: 'bands', draw: bands },
  { name: 'dots', draw: dots },
  { name: 'waves', draw: waves },
  { name: 'chevrons', draw: chevrons },
  { name: 'blocks', draw: blocks },
  { name: 'rays', draw: rays },
  { name: 'wedge', draw: wedge },
  { name: 'bust', draw: bust },
  { name: 'pair', draw: pair },
];

// People are over-represented against the landscape list: performer and tag art
// is people, and a portrait tile that reads as a tall landscape is what this
// list exists to avoid. Three of seven reads as faces without every tile being
// the same silhouette.
const PORTRAIT_MOTIFS = [
  { name: 'figure', draw: figure },
  { name: 'figure', draw: figure },
  { name: 'torso', draw: torso },
  { name: 'rings', draw: rings },
  { name: 'waves', draw: waves },
  { name: 'bands', draw: bands },
  { name: 'wedge', draw: wedge },
];

export const ART_WIDTH = 640;
export const ART_HEIGHT = 360;
export const PORTRAIT_WIDTH = 400;
export const PORTRAIT_HEIGHT = 600;

// ── Palettes ─────────────────────────────────────────────
// Each returns { bgA, bgB, stroke }: the two grounds are the stops of a
// diagonal gradient, and `stroke` is every mark drawn on top.

/** A hue at mid-lightness, with a mark colour far from both. Grounds stay in
 *  the mid tones: a wall of near-black tiles reads as "nothing loaded" at ten
 *  feet, which the `dark` regime does on purpose, rarely. */
function sweepPalette(rng) {
  const hue = Math.floor(rng() * 360);
  const hue2 = (hue + 30 + Math.floor(rng() * 90)) % 360;
  const accentHue = (hue + 150 + Math.floor(rng() * 70)) % 360;
  return {
    bgA: `hsl(${hue} ${n(38 + rng() * 26)}% ${n(20 + rng() * 9)}%)`,
    bgB: `hsl(${hue2} ${n(34 + rng() * 26)}% ${n(33 + rng() * 13)}%)`,
    stroke: `hsl(${accentHue} ${n(62 + rng() * 26)}% ${n(64 + rng() * 14)}%)`,
  };
}

/** Warm and low-key: 8–40° is the skin-and-ember arc; grounds at 12–26%
 *  lightness keep the tile close in *value* to `--bg-base`, with one lit mark
 *  well above them. A single subject on a dark field, as a real cover mostly is
 * , the case the white chrome and blue focus ring were never drawn against. */
function warmPalette(rng) {
  const hue = 8 + Math.floor(rng() * 32);
  const hue2 = (hue + 4 + Math.floor(rng() * 18)) % 360;
  return {
    bgA: `hsl(${hue} ${n(22 + rng() * 24)}% ${n(12 + rng() * 14)}%)`,
    bgB: `hsl(${hue2} ${n(20 + rng() * 26)}% ${n(22 + rng() * 18)}%)`,
    // hue − 10 … hue + 14: a lighter tone of the same arc, not a contrast
    // colour, which would just look like the sweep.
    stroke: `hsl(${(hue + 350 + Math.floor(rng() * 25)) % 360}`
          + ` ${n(30 + rng() * 30)}% ${n(62 + rng() * 20)}%)`,
  };
}

/** Near-black. Both grounds sit below `--bg-base`, so the tile's edge and the
 *  40% focus scrim have nothing to sit against; the mark is dim too, since a
 *  bright one would restore the contrast this regime removes. */
function darkPalette(rng) {
  const hue = Math.floor(rng() * 360);
  const hue2 = (hue + 20 + Math.floor(rng() * 60)) % 360;
  return {
    bgA: `hsl(${hue} ${n(10 + rng() * 25)}% ${n(4 + rng() * 5)}%)`,
    bgB: `hsl(${hue2} ${n(10 + rng() * 28)}% ${n(8 + rng() * 8)}%)`,
    stroke: `hsl(${(hue + 160 + Math.floor(rng() * 60)) % 360}`
          + ` ${n(30 + rng() * 40)}% ${n(35 + rng() * 25)}%)`,
  };
}

/** Blown out. Grounds above 70% lightness and barely saturated, as a real
 *  overexposed frame is; marks are *darker* than the ground, so white type and
 *  the white play icon have nowhere to go. */
function blownPalette(rng) {
  const hue = Math.floor(rng() * 360);
  const hue2 = (hue + 30 + Math.floor(rng() * 60)) % 360;
  return {
    bgA: `hsl(${hue} ${n(4 + rng() * 20)}% ${n(78 + rng() * 14)}%)`,
    bgB: `hsl(${hue2} ${n(4 + rng() * 22)}% ${n(70 + rng() * 18)}%)`,
    stroke: `hsl(${(hue + 180 + Math.floor(rng() * 90)) % 360}`
          + ` ${n(20 + rng() * 40)}% ${n(32 + rng() * 30)}%)`,
  };
}

/** Clutter: mid, desaturated, deliberately without a contrast pair, so three
 *  overlapping motifs merge into one busy field instead of resolving. */
function clutterPalette(rng) {
  const hue = Math.floor(rng() * 360);
  const hue2 = (hue + 15 + Math.floor(rng() * 50)) % 360;
  return {
    bgA: `hsl(${hue} ${n(8 + rng() * 16)}% ${n(28 + rng() * 14)}%)`,
    bgB: `hsl(${hue2} ${n(8 + rng() * 18)}% ${n(35 + rng() * 15)}%)`,
    stroke: `hsl(${(hue + 40 + Math.floor(rng() * 120)) % 360}`
          + ` ${n(14 + rng() * 26)}% ${n(48 + rng() * 18)}%)`,
  };
}

/**
 * The regimes and their weights. Read the header before changing them: the
 * numbers are a claim about what a library looks like, and nothing outside
 * this file depends on the exact values, only their rough shape.
 */
const REGIMES = [
  { name: 'sweep', weight: 12, palette: sweepPalette, marks: 1 },
  { name: 'warm', weight: 6, palette: warmPalette, marks: 1 },
  { name: 'dark', weight: 1, palette: darkPalette, marks: 1 },
  { name: 'blown', weight: 1, palette: blownPalette, marks: 1 },
  { name: 'clutter', weight: 1, palette: clutterPalette, marks: 3 },
];

/** Weighted pick from one draw in [0, 1). */
function pickRegime(r) {
  const total = REGIMES.reduce((sum, e) => sum + e.weight, 0);
  let x = r * total;
  for (const entry of REGIMES) {
    x -= entry.weight;
    if (x < 0) return entry;
  }
  // Only reachable if `r` is exactly 1, which mulberry32 never returns.
  return REGIMES[REGIMES.length - 1];
}

/**
 * Everything `coverArt` decides, before anything is drawn. Three independent
 * streams off the one seed keep regime, palette and motif from tracking each
 * other across neighbouring ids. `artPlan` exposes the result as data and
 * `coverArt` renders it; sharing this function keeps the two in agreement.
 */
function planArt(seed, { portrait = false } = {}) {
  const paletteRng = makeRng(`${seed}|p`);
  const layoutRng = makeRng(`${seed}|m`);
  const regime = pickRegime(makeRng(`${seed}|r`)());

  const w = portrait ? PORTRAIT_WIDTH : ART_WIDTH;
  const h = portrait ? PORTRAIT_HEIGHT : ART_HEIGHT;

  const motifs = portrait ? PORTRAIT_MOTIFS : LANDSCAPE_MOTIFS;
  const chosen = [];
  for (let i = 0; i < regime.marks; i += 1) {
    chosen.push(motifs[Math.floor(layoutRng() * motifs.length)]);
  }

  return {
    regime: regime.name,
    colors: regime.palette(paletteRng),
    motifs: chosen,
    // Handed on rather than re-derived: the motif draws must continue the
    // stream the selection drew from, or the two would drift apart.
    layoutRng,
    width: w,
    height: h,
    portrait,
  };
}

/**
 * What `coverArt(seed)` will decide, as plain data: regime, three colours and
 * the motif names it will draw (three for `clutter`, one otherwise).
 *
 * Exported so a plan is checkable: tests can assert every regime and motif is
 * *reachable* rather than merely listed, and the contact sheet can label each
 * tile with its decision.
 */
export function artPlan(seed, opts) {
  const plan = planArt(seed, opts);
  return {
    regime: plan.regime,
    colors: plan.colors,
    motifs: plan.motifs.map(m => m.name),
    width: plan.width,
    height: plan.height,
    portrait: plan.portrait,
  };
}

/**
 * A cover for `seed`, as a data URI ready for `<img src>`. `portrait` picks the
 * taller canvas and its motifs. Every choice is a function of the seed alone;
 * see the determinism note at the top.
 */
export function coverArt(seed, opts) {
  const plan = planArt(seed, opts);
  const { width: w, height: h, colors } = plan;

  const body = plan.motifs
    .map(m => m.draw(plan.layoutRng, w, h, colors.stroke))
    .join('');

  // The gradient id is a fixed `g`: each cover is its own data URI and SVG
  // document, so there is nothing to collide with. Inlining several into one
  // SVG would collide, which is why `scripts/contact-sheet.mjs` rasterises
  // each tile separately.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"`
    + ` viewBox="0 0 ${w} ${h}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="${colors.bgA}"/><stop offset="1" stop-color="${colors.bgB}"/>`
    + `</linearGradient></defs>`
    + `<rect width="${w}" height="${h}" fill="url(#g)"/>`
    + body
    + `</svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
