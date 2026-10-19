/**
 * mockArt.js — the covers Test mode draws for itself.
 *
 * Test mode used to give every scene, marker and performer a `picsum.photos`
 * URL. Two things were wrong with that, and neither is about taste:
 *
 *   - It made the app fetch pictures from an unrelated third party just to have
 *     something to draw, so "Test mode" was not offline, and a media app was
 *     reporting its usage to a stock-photo service.
 *   - The pictures were random per request. The same card could show a
 *     different scene's cover after a reload, and durations and ratings
 *     reshuffled with them, so nothing about a layout could be compared before
 *     and after a change.
 *
 * These are SVG data URIs derived from the item's own id: deterministic (the
 * same scene gets the same picture, every load), offline, and distinct enough
 * that no two cards are ever mistaken for one another — which is the only
 * property Test mode actually needs from a cover.
 *
 * ── Since 0.13.0: regimes, and what Test mode is actually for ─────────────
 *
 * The generator used to have exactly one palette: a uniform sweep over hue at
 * mid-lightness. That is a good way to make 48 tiles tellable apart and a poor
 * model of a real library, which is overwhelmingly warm, skin-tone-dominant and
 * low-key — one lit subject on a dark field. The result was that the UI was
 * never tested against the covers most likely to break it: white chrome, the 40%
 * black scrim on a focused card (`VideoCard.module.css`) and a blue focus ring,
 * all drawn over a tile whose value sits close to `--bg-base` (#202b33).
 *
 * So the palette is now chosen per seed from a small table of *regimes*, and a
 * deliberate minority of seeds land on adversarial ones. The weights live in
 * `REGIMES` and are meant to be tuned by whoever looks at the contact sheet;
 * the check in `scripts/verify-mockart.mjs` asserts only their rough shape — the
 * sweep stays the majority, the three hard regimes stay rare — so that a regime
 * can neither quietly become the whole library nor quietly become dead code.
 *
 *   sweep     the old behaviour     ~57%   ordinary, well-behaved hue sweep
 *   warm      dark, skin-toned      ~29%   one lit subject on a dark field
 *   dark      near-black            ~5%    the tile dissolves into the page
 *   blown     near-white            ~5%    white chrome and the scrim vanish
 *   clutter   three motifs at once  ~5%    the focus ring has nothing to sit on
 *
 * **Two consequences, stated here so they are decided rather than discovered:**
 *
 *   - A Test-mode screen now reads as an adult library; that is what the warm
 *     regime and the human-form motifs are for. A Test-mode screenshot is no
 *     longer the neutral artefact it was.
 *   - A few tiles now look, individually, like a cover that failed to load.
 *     That is the near-black regime working as designed. It is the specific
 *     thing the notes below about "a wall of near-black tiles reads as nothing
 *     loaded" guard against — the answer being that a *wall* of them is still
 *     not what this generates.
 *
 * ── Determinism is load-bearing, not decorative ───────────────────────────
 *
 * Every differential diff in this project rests on `coverArt(seed)` being a pure
 * function of its seed; the P1 grid migration was verified that way. So all the
 * vocabulary is drawn through `makeRng`, there is no `Math.random()` and no
 * clock, and `scripts/verify-mockart.mjs` proves that behaviourally rather than
 * by grepping the source: it stubs `Math.random` and `Date.now` to throw and
 * then calls `coverArt`, so either one being reached is a loud failure rather
 * than a silent drift.
 *
 * It also stays SVG, so it stays abstract. That is not a compromise, it is the
 * mechanism: real imagery in a data URI means committing adult content as
 * source, and the one reference screenshot this project has is gitignored for
 * exactly that reason. Procedural suggestion is the version of this that can
 * live in the repo.
 */

/**
 * FNV-1a, 32-bit. Any stable hash would do; this one is four lines and has no
 * dependencies.
 */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 — a deterministic PRNG, so a seeded id always yields the same
 * numbers. The generators use this instead of `Math.random()`; see the note at
 * the top for why that mattered.
 *
 * The mixing matters more than it looks. The first version of this was
 * xorshift32, whose low bits are weakly decorrelated between nearby seeds —
 * so `scene-0` through `scene-47` produced hue and motif that tracked each
 * other, and the contact sheet came back with a dot grid every second tile.
 * Independent streams (`seed|p` for the palette, `seed|m` for the motif, `|r`
 * for the regime) are the other half of that fix; see `planArt`.
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
// Each draws into a width×height box with the palette it is handed and
// returns SVG markup. What a test cover has to do is be *recognisably itself*
// at 200px wide on a TV across the room, so the marks are large and few.

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
  // Offset by a fraction of the *gap*, not of the canvas times the gap — that
  // literal reading put the first band tens of thousands of pixels down and
  // the loop never ran, which is why this motif used to come back as a bare
  // gradient. Starting slightly above the top keeps the first band off the
  // edge rather than clipped against it.
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

/** A single diagonal edge with the far side filled — the plainest possible
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
// Three motifs draw a person, and all three are the same silhouette at
// different proportions — which is why the arithmetic below is written once.

/**
 * Head and shoulders, with the shoulders actually meeting the chin.
 *
 * The obvious spelling does not do that: a quadratic control point near the
 * chin puts the dome apex ~150px lower than intended, because a quadratic only
 * reaches *halfway* to its control point — the first version of this read as a
 * sun over a hill. It was rendered, looked at, and was still wrong; this
 * arithmetic is what it took to make them touch, and it is worth not
 * re-deriving in a fourth motif.
 *
 * Apex of Q(P0, C, P2) with both endpoints at y = base is 0.5·base + 0.5·Cy,
 * so solving for apex = chin gives Cy = 2·chin − base. That is negative
 * whenever the head sits above mid-frame, which is the usual case and is fine:
 * only the curve near t = 0.5 is ever drawn from it.
 *
 * **Meeting is not enough, which the first version of this got wrong in the
 * other direction.** With the apex exactly at the chin the two shapes are
 * *tangent* — they touch at a single point and the neck has zero width, so at
 * 200px a figure reads as a ball resting on a hill, and the wide-shouldered
 * `torso` only looked right by accident (a flatter dome reaches apex height
 * across a wider arc). Sinking the apex by `NECK · headR` gives the join a real
 * width: the circle at that depth already spans
 * `2·headR·√(2·NECK − NECK²)`, which at 0.22 is a little over half the head,
 * and that is what reads as a neck rather than as a balance.
 *
 * `shoulder` is a half-width, so the shape spans 2·shoulder.
 */
const NECK = 0.22;

// The `fade` argument exists for `pair`, which draws one figure behind another:
// the far one is the same silhouette at reduced opacity, which is what makes
// the composition read as two people rather than as one wide person.

function silhouette(cx, headY, headR, shoulder, base, stroke, fade = 1) {
  const chin = headY + headR;
  const control = 2 * (chin - headR * NECK) - base;
  return `<path d="M ${n(cx - shoulder)} ${n(base)}`
       + ` Q ${n(cx)} ${n(control)} ${n(cx + shoulder)} ${n(base)} Z"`
       + ` fill="${stroke}" opacity="${n(0.45 * fade, 2)}"/>`
       + `<circle cx="${n(cx)}" cy="${n(headY)}" r="${n(headR)}"`
       + ` fill="${stroke}" opacity="${n(0.8 * fade, 2)}"/>`;
}

/** Portrait: a person standing in the frame, shoulders running off the bottom
 *  edge. Sized off the width so it fills the frame rather than sitting in it. */
function figure(rng, w, h, stroke) {
  const cx = w * (0.42 + rng() * 0.16);
  const headR = w * (0.17 + rng() * 0.05);
  const headY = h * (0.3 + rng() * 0.06);
  const shoulder = headR * (2.1 + rng() * 0.4);
  return silhouette(cx, headY, headR, shoulder, h, stroke);
}

/** Portrait: a tighter crop than `figure` — a larger head and shoulders wider
 *  than the frame, so both edges cut the body and the tile reads as a close-up
 *  rather than as a person standing in it. The two are deliberately different
 *  reads at 200px, which is the only size that matters here. */
function torso(rng, w, h, stroke) {
  const cx = w * (0.36 + rng() * 0.28);
  const headR = w * (0.25 + rng() * 0.07);
  const headY = h * (0.22 + rng() * 0.08);
  const shoulder = w * (0.72 + rng() * 0.2);
  return silhouette(cx, headY, headR, shoulder, h, stroke);
}

/** Landscape: the same silhouette, sized off the *height*. A head sized off the
 *  width of a 16:9 canvas fills it top to bottom, which is how the first
 *  attempt at this came back as a portrait crop with no room around it. */
function bust(rng, w, h, stroke) {
  const cx = w * (0.34 + rng() * 0.32);
  const headR = h * (0.15 + rng() * 0.06);
  const headY = h * (0.3 + rng() * 0.1);
  const shoulder = headR * (2.6 + rng() * 0.8);
  return silhouette(cx, headY, headR, shoulder, h, stroke);
}

/** Landscape: two figures, one behind the other, at different scales and
 *  opacities. The `fade` on the far one is what stops the pair reading as one
 *  oddly wide person.
 *
 *  This replaced an attempt at a *reclining* figure — a torso capsule with a
 *  leg bent at the hip and the head raised off the axis — which is the pose the
 *  content suggests and which was rendered twice and looked at twice. Both
 *  times it read as a rolling pin with a ball on the end, and the second
 *  attempt, with a bigger head and a gentler bend, read as one still. A
 *  silhouette has no interior detail to say "person", so a body lying down is
 *  just a long rounded rectangle; two upright ones are unmistakable at 200px.
 *  If it is ever wanted back, that is the bar it has to clear. */
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

// Named rather than bare functions so a plan can be reported — and asserted on —
// by name. A property name on an object literal survives minification, where a
// bare function's `.name` does not; these have to be readable in a production
// build for the check to mean anything.
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

// People are over-represented here against the landscape list, deliberately:
// performer and tag art is people, and a portrait tile that reads as a
// landscape that happens to be tall is the specific thing this list exists to
// avoid. Three of seven is a wall that reads as faces without every tile being
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
// Each returns { bgA, bgB, stroke }. The two grounds are the stops of a diagonal
// gradient; `stroke` is every mark drawn on top of them.

/** The original: a hue at mid-lightness, with a mark colour a long way from
 *  both. Grounds sit in the mid tones rather than at the bottom of the range,
 *  because a wall of near-black tiles reads as "nothing loaded" at ten feet —
 *  which is exactly what the `dark` regime below now does on purpose, rarely. */
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

/** Warm and low-key: 8–40° is the skin-and-ember arc, the grounds sit at 12–26%
 *  lightness so the tile is close in *value* to `--bg-base`, and the one mark
 *  colour is a lit tone well above them. That is a single subject on a dark
 *  field, which is what a real cover mostly is, and it is the case the app's
 *  white chrome and blue focus ring were never drawn against. */
function warmPalette(rng) {
  const hue = 8 + Math.floor(rng() * 32);
  const hue2 = (hue + 4 + Math.floor(rng() * 18)) % 360;
  return {
    bgA: `hsl(${hue} ${n(22 + rng() * 24)}% ${n(12 + rng() * 14)}%)`,
    bgB: `hsl(${hue2} ${n(20 + rng() * 26)}% ${n(22 + rng() * 18)}%)`,
    // hue − 10 … hue + 14: a lighter tone of the same arc, not a contrast
    // colour. A saturated complement here would just look like the sweep.
    stroke: `hsl(${(hue + 350 + Math.floor(rng() * 25)) % 360}`
          + ` ${n(30 + rng() * 30)}% ${n(62 + rng() * 20)}%)`,
  };
}

/** Near-black. Both grounds sit below `--bg-base`, so the tile's edge — and the
 *  40% scrim on a focused card — has almost nothing to sit against. The mark
 *  colour is dim as well: a bright one would restore the contrast this regime
 *  exists to remove. */
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

/** Blown out. Grounds above 70% lightness and barely saturated, the way a real
 *  overexposed frame desaturates; the marks are *darker* than the ground, which
 *  is the other half of why this regime is hard — white type and the white play
 *  icon have nowhere to go. */
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

/** For the clutter regime: mid, desaturated, and deliberately without a
 *  contrast pair, so three motifs of overlapping marks merge into one busy
 *  field instead of resolving into shapes. */
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
 * The regimes and their weights. Read the header before changing these: the
 * numbers are a claim about what a library looks like, and nothing outside this
 * file depends on the exact values — only on their rough shape.
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
 * Everything `coverArt` decides, before anything is drawn.
 *
 * Three independent streams off the one seed, so the regime, the palette and
 * the motif cannot track each other across neighbouring ids — the failure the
 * xorshift32 note in `makeRng` describes. `artPlan` exposes the result as data;
 * `coverArt` renders it. They are one function underneath so the two can never
 * disagree about what a seed produces.
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
    // Handed on rather than re-derived: the motif draws have to continue the
    // same stream the selection drew from, and recomputing it in `coverArt`
    // would be a second copy of that fact, free to drift.
    layoutRng,
    width: w,
    height: h,
    portrait,
  };
}

/**
 * What `coverArt(seed)` will decide, as plain data: the regime, the three
 * colours, and the names of the motifs it will draw — three of them for
 * `clutter`, one otherwise.
 *
 * Exported because a plan nobody can read is a plan nobody can check. This is
 * what lets a test assert that every regime and every motif is *reachable*
 * rather than merely listed, and what lets the contact sheet label each tile
 * with the decision behind it.
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
 * A cover for `seed`, as a data URI ready for an `<img src>`.
 *
 * `portrait` picks the taller canvas and the motifs that suit it. Every choice
 * is a function of the seed alone, so the same seed is always the same picture
 * — see the determinism note at the top of this file for why that is not
 * negotiable.
 */
export function coverArt(seed, opts) {
  const plan = planArt(seed, opts);
  const { width: w, height: h, colors } = plan;

  const body = plan.motifs
    .map(m => m.draw(plan.layoutRng, w, h, colors.stroke))
    .join('');

  // The gradient id is a fixed `g` rather than something seed-derived: each
  // cover is its own data URI and therefore its own SVG document, so there is
  // nothing for it to collide with. A contact sheet that inlined several of
  // these into one SVG would have exactly that problem, which is why
  // `scripts/contact-sheet.mjs` rasterises each tile separately.
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
