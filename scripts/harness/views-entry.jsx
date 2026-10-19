/**
 * Headless driver for per-section view modes (0.10.0's P3).
 *
 * Mounts the whole `App`, like rail-entry, and for the same reason: the claim
 * is about App owning the mode, a page reading it and a section's cards
 * rendering under it. No single component can be asked any of it alone.
 *
 * Two claims, and they are separate.
 *
 * 1. THE CAROUSEL IS GENERAL. It was `VideoCarousel` and knew about scenes in
 *    four places — the service, the card, the `video-` id prefix and the
 *    fields it printed in the hero. All four are now the `view` descriptor.
 *    The failure mode that matters is the *silent* one: a wrong `focusPrefix`
 *    renders a perfectly good strip that never tracks the focus, so the hero
 *    freezes on row 1 and nothing throws. V2 walks the strip and watches the
 *    hero move, and V1 asserts the prefix is one the cards actually use rather
 *    than merely non-empty. `itemsKey` is the same class of mistake — it would
 *    yield an empty list and the "No performers found." state, which V0 reads
 *    before anything else.
 *
 * 2. THE MODE IS PER SECTION AND IT SURVIVES A RESTART. `viewModes` is keyed
 *    by tab, so setting Performers to Carousel must leave Scenes alone; the
 *    absent-key-means-classic rule is what makes that work without a migration
 *    entry per section. And it is a persisted field, which in settings.js is a
 *    known trap: a field that is written to state but left out of
 *    `persistToStorage` or of `setSettings`' guard list appears to work for
 *    the rest of the session and is gone on the next launch. That is exactly
 *    what happened to `previewsEnabled`, and to `useMock` before it. V4 reads
 *    localStorage directly, so it covers the guard list rather than the state.
 *
 * Seeding happens through `setSettings` *before* the first render.
 *
 * **That is not what a relaunch does, and the sentence that used to stand here
 * claiming otherwise is what let 0.10.0 ship a blank screen.** It read: "a
 * pre-mount write is the same observable thing as a saved value". It is not.
 * A relaunch writes storage and *then* evaluates `settings.js`; `setSettings`
 * runs *after* evaluation, so it can only exercise functions that already
 * have their module scope fully initialised. 0.10.0's `readViewModes` read a
 * `const` declared below the module-init call that reached it, so it threw for
 * any device with a saved `viewModes` — and every check in this file passed,
 * because none of them ever loaded the module the way a launch does. See
 * `boot-entry.jsx`, which does exactly that and nothing else.
 *
 * 3. THE HERO'S ENRICHMENT IS PRESENT, AND STAYS BOUNDED. Tag descriptions and
 *    studio details became the strip's third hero row, and aliases / a studio's
 *    parent became meta entries (0.29.0). V8 walks tags 1, 2, 3 and 4 and
 *    studios 1, 3, 4 and 5 to reach every populated/empty combination, and
 *    measures the two-line clamp on deliberately overlong fixture text rather
 *    than trusting the rule to be applied. Empty values must draw nothing —
 *    an empty row on half the library reads as a layout bug.
 *
 * What this cannot tell you: whether the portrait slots look right. V3 asserts
 * the override is applied and nothing more; 166px is arithmetic (see the note
 * on `--slot-w` in Carousel.module.css), not taste, and the strip is built for
 * a 1080p stage this window only approximates.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry, getCurrentFocusId } from '../../src/hooks/useFocusable.js';
import { PERFORMER_VIEW } from '../../src/components/carouselViews.js';
import { setSettings, getSettings, readViewModes } from '../../src/utils/settings.js';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});
const errorTail = () => (errors.length ? errors.slice(-2).join(' | ') : 'none');

async function waitFor(pred, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

async function press(key) {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await sleep(150);
}

async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(250);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};

// ── Reading what is on screen ───────────────────────────────
// The strip is identified by structure rather than by a class name — CSS
// modules hash those. `--slot-w` is a custom property, which is not hashed
// and is the one thing V3 needs to read.
const heroTitle = () => document.querySelector('[class*="heroTitle"]')?.textContent ?? null;
const stripWrapper = () => document.querySelector('[class*="carouselWrapper"]');
// ItemList deliberately keeps `role="grid"` (see its header), so a check for
// the Classic grid has to exclude it — otherwise List would read as "still a
// grid" and V5's shape assertions would pass for the wrong reason.
const gridEl = () => document.querySelector('[role="grid"]:not([data-list-mode])');
const listEl = () => document.querySelector('[role="grid"][data-list-mode]');
const stripEl = () => document.querySelector('[role="region"][aria-label$="carousel"]');

const cardIds = (prefix) => [...registry.keys()].filter(k => k.startsWith(prefix));

// The Mode control is not a <select> — it is a button that opens a listbox
// (SelectControl in ControlsPanel), so the value on screen is its text, which
// is the selected option's label. Read through the focus registry because the
// button carries no DOM id and CSS modules hash the class names; `useDropdown`
// registers it under the id its caller passes.
//
// This is the app's own statement of which mode it is in, which is a different
// claim from the settings store's — V0/V1/V5 are checking that the control and
// the section agree, not that the store holds a string.
const modeControlText = () => registry.get('ctrl-mode')?.el.textContent?.trim() ?? null;

// ── What is on screen ───────────────────────────────────────
// Coverflow has no role of its own to match on, so "is this coverflow" is
// answered by the control saying so plus the absence of the two shapes that do
// have roles. Weak on its own; specific enough taken together, and V5 asserts
// all three rather than the disjunction a single grep would give.
const isCoverflow = () =>
  modeControlText() === 'Coverflow' && !gridEl() && !stripEl();

const activeRow = () =>
  document.querySelector('nav[aria-label="Main navigation"] [aria-current="page"]');

// Change the mode the way a remote does: open the dropdown, pick the option.
// Option ids are `${parentId}-opt-${value}` (DropdownOption in ControlsPanel),
// and the trigger is registered as `ctrl-mode`.
async function driveMode(value) {
  if (!focus('ctrl-mode')) return false;
  await tapEnter();
  await sleep(250);
  if (!focus(`ctrl-mode-opt-${value}`)) return false;
  await tapEnter();
  await sleep(400);
  return true;
}

async function switchTab(rowId) {
  if (!focus(rowId)) return false;
  await tapEnter();
  await sleep(600);
  return true;
}

// ── The run ─────────────────────────────────────────────────
async function run() {
  // Seed: performers → carousel, and nothing at all for scenes. The sparse map
  // is the point of V0/V5 — an unset tab must fall back to classic on its own.
  // (The scene listing moved from Home to Scenes in 0.15.0; Home is the
  // showroom and has no mode control at all, so Scenes is the unset tab.)
  setSettings({ stashUrl: `http://127.0.0.1:${window.__PORT__}`, stashKey: 'harness', useMock: false, onboarded: 'live' });
  setSettings({ viewModes: { performers: 'carousel' } });

  const started = await waitFor(() => registry.size > 0, 6000);
  check('V0 the app mounted with a seeded viewModes map', started, errorTail());
  if (!started) return;

  // ── 1. An unset tab is classic, and only the seeded one is not ──
  // Scenes, not Home: Home is the showroom since 0.15.0 and carries no
  // controls bar at all, so its (absent) mode would answer a different
  // question. Switched the way a remote does it.
  //
  // Waiting on the first card rather than on the page: an empty tab renders
  // the loading state, which has neither a grid role nor a strip, so an
  // immediate read would call a working grid "neither".
  const scenesTab = await switchTab('nav-scenes');
  const scenesLoaded = await waitFor(() => cardIds('video-').length > 0, 6000);
  check('V0 scenes loaded its listing', scenesTab && scenesLoaded,
    `${cardIds('video-').length} video- ids; rail row ${scenesTab ? 'found' : 'missing'}`);
  check('V0 scenes is a grid — its tab is absent from viewModes',
    !!gridEl() && !stripEl(),
    `grid=${!!gridEl()} strip=${!!stripEl()}`);
  check('V0 the Mode control reads Classic on that tab',
    modeControlText() === 'Classic', `control reads "${modeControlText()}"`);
  // Present here so the later "hidden in List" check has a positive control:
  // an element that is absent in both modes would make that check vacuous.
  check('V0 the column control is present in Classic',
    !!registry.get('grid-cols-dec'), `registry has grid-cols: ${!!registry.get('grid-cols-dec')}`);

  // ── 2. Performers renders the strip, from the performer descriptor ──
  await switchTab('nav-performers');
  check('V1 the rail moved to Performers',
    (activeRow()?.textContent ?? '').trim().toLowerCase().startsWith('performers'),
    `active row reads "${(activeRow()?.textContent ?? '').trim()}"`);
  await waitFor(() => cardIds('performer-').length > 0, 6000);
  check('V1 the tab that was set to carousel is showing a carousel',
    !!stripEl() && !gridEl(),
    `strip=${!!stripEl()} grid=${!!gridEl()}`);
  check('V1 the Mode control reads Carousel on that tab',
    modeControlText() === 'Carousel', `control reads "${modeControlText()}"`);

  const performerIds = cardIds('performer-');
  check('V1 the cards are performers, and the strip found them',
    performerIds.length > 0, `${performerIds.length} performer- ids registered`);
  check('V1 no scene card leaked in',
    cardIds('video-').length === 0, `${cardIds('video-').length} video- ids`);

  const firstTitle = heroTitle();
  check('V1 the hero names a performer, not a scene',
    typeof firstTitle === 'string' && firstTitle.length > 0 && !/^VERIFY scene/.test(firstTitle),
    `hero reads "${firstTitle}"`);

  // Read the prefix `out of the descriptor` rather than naming 'performer-'
  // here. Writing the literal would make this check insensitive to the very
  // field it is about: the descriptor could say `video` and this would still
  // find performer cards on screen and pass.
  const prefix = PERFORMER_VIEW.focusPrefix;
  check('V1 the descriptor\'s focusPrefix is one its cards actually register',
    cardIds(`${prefix}-`).length > 0,
    `focusPrefix="${prefix}" → ${cardIds(`${prefix}-`).length} matching ids`);

  // ── 3. Portrait art gets its own slot width ──
  const wrapper = stripWrapper();
  const slotW = wrapper && getComputedStyle(wrapper).getPropertyValue('--slot-w').trim();
  check('V3 the portrait strip overrides --slot-w',
    slotW === '166px', `--slot-w = "${slotW}" (16:9 default is 360px)`);

  // ── 4. Focus tracking: the thing a wrong prefix breaks silently ──
  // Careful to compare against a *different* row: if focus never moves, the
  // hero stays on row 1 and a check that only asserted "a title is present"
  // would pass on the broken build.
  const row1 = heroTitle();
  const walked = [];
  for (let i = 0; i < 4; i++) {
    await press('ArrowRight');
    walked.push(heroTitle());
  }
  check('V2 the hero follows the focus along the strip',
    walked.some(t => t && t !== row1),
    `${JSON.stringify([row1, ...walked])}`);
  check('V2 and the strip stayed in the same section',
    cardIds('performer-').length > 0, `${cardIds('performer-').length} performer- ids`);
  check('V2 the focused id is a performer card, not a rail row',
    String(getCurrentFocusId() || '').startsWith('performer-'),
    `focus = ${getCurrentFocusId()}`);

  // ── 5. Changing one section's mode leaves the others alone ──
  // Driven through the real Mode control, not by writing the store: the claim
  // is about what App does when the user changes a mode, and a check that
  // called setSettings with the same spread App uses would be testing the
  // driver's copy of the line.
  //
  // The trap: writing `{ [activeTab]: mode }` instead of spreading the current
  // map resets every OTHER section to classic — and since classic is also what
  // an absent key means, the section you did not touch looks fine unless it was
  // the one carrying a non-default mode. Performers is carrying one (seeded
  // above), which is what makes the wipe visible at all.
  check('V5 the Mode control is reachable in the bar',
    !!registry.get('ctrl-mode'), `registry has ctrl-mode: ${!!registry.get('ctrl-mode')}`);

  await switchTab('nav-scenes');
  await waitFor(() => !!registry.get('ctrl-mode-opt-coverflow') || isCoverflow(), 4000);
  const droveScenes = await driveMode('coverflow');
  check('V5 the Mode control set Scenes to Coverflow', droveScenes && isCoverflow(),
    `drove=${droveScenes} control="${modeControlText()}"`);

  await switchTab('nav-performers');
  await waitFor(() => cardIds('performer-').length > 0, 6000);
  check('V5 and performers kept the mode it already had',
    modeControlText() === 'Carousel' && !!stripEl(),
    `control="${modeControlText()}" strip=${!!stripEl()}`);
  check('V5 the store holds both, under their own keys',
    getSettings().viewModes.performers === 'carousel'
      && getSettings().viewModes.scenes === 'coverflow',
    JSON.stringify(getSettings().viewModes));

  // List is the fourth mode and the only one that adds a renderer, so it is
  // driven through the same control rather than written straight to the store:
  // the claim is that App selects the list renderer, not that the string
  // validates. Scenes is the tab whose other three modes have all been seen,
  // which makes the transition the interesting one.
  await switchTab('nav-scenes');
  await waitFor(() => !!registry.get('ctrl-mode') && cardIds('video-').length > 0, 6000);
  const droveList = await driveMode('list');
  const listUp = await waitFor(() => !!listEl(), 4000);
  check('V5 the Mode control set Scenes to List', droveList && listUp,
    `drove=${droveList} control="${modeControlText()}" list=${!!listEl()}`);
  check('V5 List replaced both the grid and the strip',
    !!listEl() && !gridEl() && !stripEl(),
    `list=${!!listEl()} grid=${!!gridEl()} strip=${!!stripEl()}`);
  // List has no columns to set. Showing the control would offer a setting that
  // does nothing, which is worse than offering nothing.
  check('V5 the column control is hidden in List mode',
    !registry.get('grid-cols-dec'), `registry has grid-cols: ${!!registry.get('grid-cols-dec')}`);
  check('V5 switching Scenes to List left Performers on Carousel',
    getSettings().viewModes.performers === 'carousel'
      && getSettings().viewModes.scenes === 'list',
    JSON.stringify(getSettings().viewModes));

  // ── 6. The persisted field is actually persisted ──
  // Read from storage, not from state: settings.js persists a whitelist, and a
  // field missing from it behaves correctly until the next launch.
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem('tvapp.settings.v1') || 'null');
  } catch (e) { /* leave null, the check below says so */ }
  check('V4 viewModes reached localStorage',
    !!stored && !!stored.viewModes, JSON.stringify(stored?.viewModes ?? null));
  check('V4 and it carries every tab that was set',
    stored?.viewModes?.performers === 'carousel' && stored?.viewModes?.scenes === 'list',
    JSON.stringify(stored?.viewModes ?? null));

  // The other persisted fields have to still be there: a whitelist that was
  // *replaced* rather than extended would pass the two checks above and lose
  // the connection on the next launch.
  check('V4 the rest of the persisted settings survived',
    stored?.stashUrl === `http://127.0.0.1:${window.__PORT__}` && stored?.onboarded === 'live',
    `stashUrl=${JSON.stringify(stored?.stashUrl)} onboarded=${JSON.stringify(stored?.onboarded)}`);

  // ── 7. An unknown stored mode is refused at the boundary ──
  // A downgrade, a hand-edited value or a corrupt read must not reach a page,
  // where an unrecognised string falls through to the grid with the Mode
  // control showing nothing selected — degraded silently, which is the part
  // worth refusing. Asserted on the validator rather than by writing storage
  // and relaunching, because the validator is the boundary and it is pure.
  check('V6 an unrecognised mode is dropped, keeping the valid ones',
    JSON.stringify(readViewModes({ home: 'hologram', performers: 'carousel' }))
      === JSON.stringify({ performers: 'carousel' }),
    JSON.stringify(readViewModes({ home: 'hologram', performers: 'carousel' })));
  check('V6 list is a recognised mode at the storage boundary',
    JSON.stringify(readViewModes({ scenes: 'list' })) === JSON.stringify({ scenes: 'list' }),
    JSON.stringify(readViewModes({ scenes: 'list' })));
  check('V6 absent, null, a string and an array all read as "no modes set"',
    JSON.stringify(readViewModes(undefined)) === '{}'
      && JSON.stringify(readViewModes(null)) === '{}'
      && JSON.stringify(readViewModes('classic')) === '{}'
      && JSON.stringify(readViewModes(['classic'])) === '{}',
    `${JSON.stringify(readViewModes(undefined))} ${JSON.stringify(readViewModes(null))} `
    + `${JSON.stringify(readViewModes('classic'))} ${JSON.stringify(readViewModes(['classic']))}`);

  // ── 8. Tag and Studio heroes: blurb and meta, bounded ─────
  // Items 8/9 of the enrichment batch. The hero grew a third row (the blurb)
  // and two new meta entries (aliases; a studio's parent). Three things can go
  // wrong and none of them throws:
  //
  //   • an empty description renders an empty row instead of nothing — the
  //     hero then looks like a layout bug on half the library;
  //   • the blurb is unbounded, so the strip moves whenever the focus crosses
  //     a described entity → undescribed one;
  //   • a list (aliases) is printed in full, so a tag with thirty aliases
  //     pushes everything else off the screen.
  //
  // The fixture makes each decidable by walking a few rows: 1 has nothing,
  // 2 has a description only, 3 aliases only, and 10 a deliberately overlong
  // description (studio 5 likewise) whose clamp is measurable in pixels.
  const metaText = () => document.querySelector('[class*="heroMeta"]')?.textContent || '';
  const blurbEl = () => document.querySelector('[class*="heroBlurb"]');
  const blurbText = () => blurbEl()?.textContent || '';

  async function heroFor(tab, firstId) {
    await switchTab(`nav-${tab}`);
    await waitFor(() => !!registry.get('ctrl-mode'), 6000);
    const drove = await driveMode('carousel');
    const up = await waitFor(() => !!stripEl() && !!registry.get(firstId), 6000);
    return drove && up;
  }

  /** The blurb's two-line budget, measured rather than read off the source:
   *  a clamp that is declared but not applied (display changed, overflow
   *  re-set) still computes to two lines here, and oversized text still
   *  overflows, so `scrollHeight > clientHeight` is what proves the cut. */
  const clampProbe = (el) => {
    if (!el) return { clamp: '(no blurb)', line: 0, height: 0, scroll: 0 };
    const cs = getComputedStyle(el);
    return {
      clamp: String(cs.webkitLineClamp || cs.lineClamp || '(none)'),
      line: parseFloat(cs.lineHeight) || 0,
      height: el.clientHeight,
      scroll: el.scrollHeight,
    };
  };
  const bounded = (p) =>
    p.clamp === '2' && p.line > 0 && p.height > 0
      && p.height <= p.line * 2 + 2 && p.scroll > p.height;

  const tagsHero = await heroFor('tags', 'tag-1');
  check('V8 Tags opens a carousel', tagsHero, `strip=${!!stripEl()} control="${modeControlText()}"`);
  focus('tag-1');
  await sleep(250);
  check('V8 a tag with no description draws no blurb element at all',
    heroTitle() === 'VERIFY tag 1' && !blurbEl() && !/Aliases:/.test(metaText()),
    `title="${heroTitle()}" blurb=${!!blurbEl()} meta="${metaText().slice(0, 80)}"`);

  focus('tag-2');
  await sleep(250);
  check('V8 a described tag shows the description as the blurb',
    /VERIFY tag description 2/.test(blurbText()) && !/Aliases:/.test(metaText()),
    `blurb="${blurbText().slice(0, 70)}" meta="${metaText().slice(0, 60)}"`);

  focus('tag-3');
  await sleep(250);
  check('V8 a tagged-with-aliases, undescribed tag shows aliases and no blurb',
    /Aliases: VERIFY alias 3a, VERIFY alias 3b/.test(metaText()) && !blurbEl(),
    `meta="${metaText().slice(0, 100)}" blurb=${!!blurbEl()}`);

  // Row 4, not a later one: the strip pages five rows at a time, and focusing
  // a card that is not mounted yet silently leaves the hero where it was —
  // which is how this check first passed the fixture and failed the run.
  focus('tag-4');
  await sleep(300);
  const tagClamp = clampProbe(blurbEl());
  check('V8 a long description is clamped to two lines, not left to grow',
    /VERIFY long tag description/.test(blurbText()) && bounded(tagClamp),
    `title="${heroTitle()}" ${JSON.stringify(tagClamp)}`);

  const studiosHero = await heroFor('studios', 'studio-1');
  check('V8 Studios opens a carousel', studiosHero,
    `strip=${!!stripEl()} control="${modeControlText()}"`);
  focus('studio-1');
  await sleep(250);
  check('V8 a root studio with no parent, aliases or details draws none of them',
    heroTitle() === 'VERIFY studio 1' && !blurbEl()
      && !/Part of/.test(metaText()) && !/Aliases:/.test(metaText()),
    `title="${heroTitle()}" meta="${metaText().slice(0, 80)}"`);

  focus('studio-3');
  await sleep(250);
  check('V8 studio 3 shows its alias and no parent',
    /Aliases: VERIFY studio alias 3/.test(metaText()) && !/Part of/.test(metaText()),
    `meta="${metaText().slice(0, 100)}"`);

  focus('studio-4');
  await sleep(250);
  check('V8 studio 4 names its parent, and still no empty alias row',
    /Part of VERIFY studio 3/.test(metaText()) && !/Aliases:/.test(metaText()),
    `meta="${metaText().slice(0, 100)}"`);

  focus('studio-5');
  await sleep(300);
  const studioClamp = clampProbe(blurbEl());
  check('V8 a long studio details blurb is clamped the same way',
    /VERIFY long studio details/.test(blurbText()) && bounded(studioClamp),
    `${JSON.stringify(studioClamp)}`);

  check('V7 no render error was raised', errors.length === 0, errorTail());
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  });
  await fetch('/done', { method: 'POST' });
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);
run().then(finish).catch(async (e) => {
  check('V9 the driver itself threw', false, String(e && e.stack ? e.stack.split('\n')[0] : e));
  await finish();
});
