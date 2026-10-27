/**
 * Headless driver for per-section view modes.
 *
 * Mounts the whole App: App owns the mode, a page reads it and a section's cards
 * render under it. 1) The carousel is general, the `view` descriptor supplies
 * service, card, `focusPrefix` and hero fields; a wrong prefix renders a good
 * strip that never tracks focus, so V2 walks and V1 asserts the prefix. 2) The
 * mode is per section and survives a restart: `viewModes` is persisted, so V4
 * reads localStorage and V6 pins the validator. 3) The hero's tag/studio
 * enrichment is bounded: V8 walks every populated/empty combination and measures
 * the two-line clamp; empty values must draw nothing. Seeding uses `setSettings`
 * before the first render, which is NOT a relaunch, see boot-entry.jsx.
 * Not answerable here: whether portrait slots look right (V3 asserts 166px only).
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry, getCurrentFocusId } from '../../src/hooks/useFocusable.js';
import { focusByIdWhenReady, onFocusRestoreRequest } from '../../src/utils/focus.js';
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
// Identified by structure, not class (CSS modules hash them). `--slot-w` is a
// custom property, unhashed, and the one thing V3 reads.
const heroTitle = () => document.querySelector('[class*="heroTitle"]')?.textContent ?? null;
const stripWrapper = () => document.querySelector('[class*="carouselWrapper"]');
// ItemList keeps `role="grid"` (see its header), so the Classic check must
// exclude it, otherwise List reads as "still a grid" and V5 passes for the
// wrong reason.
const gridEl = () => document.querySelector('[role="grid"]:not([data-list-mode])');
const listEl = () => document.querySelector('[role="grid"][data-list-mode]');
const stripEl = () => document.querySelector('[role="region"][aria-label$="carousel"]');

const cardIds = (prefix) => [...registry.keys()].filter(k => k.startsWith(prefix));

// The Mode control is a button opening a listbox (SelectControl), so its text is
// the selected label. Read via the registry (no DOM id, hashed classes); this is
// the app's own statement of its mode, not the store's.
const modeControlText = () => registry.get('ctrl-mode')?.el.textContent?.trim() ?? null;

// ── What is on screen ───────────────────────────────────────
// Coverflow has no role to match, so it is "control says so" plus the absence of
// the two shapes that do. V5 asserts all three rather than the disjunction.
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
  // Seed performers → carousel, nothing for scenes. The sparse map is the point:
  // an unset tab must fall back to classic. Home is the showroom with no mode
  // control, so Scenes is the unset tab.
  setSettings({ stashUrl: `http://127.0.0.1:${window.__PORT__}`, stashKey: 'harness', useMock: false, onboarded: 'live' });
  setSettings({ viewModes: { performers: 'carousel' } });

  const started = await waitFor(() => registry.size > 0, 6000);
  check('V0 the app mounted with a seeded viewModes map', started, errorTail());
  if (!started) return;

  // ── 1. An unset tab is classic, and only the seeded one is not ──
  // Scenes, not Home (the showroom has no controls bar). Wait on the first card:
  // a loading tab has neither a grid role nor a strip, so an early read miscalls it.
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

  // Read the prefix out of the descriptor rather than naming 'performer-': the
  // literal would make this insensitive to the field it tests, `video` would
  // still find performer cards on screen and pass.
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
  // Compare against a different row: if focus never moves, the hero stays on row
  // 1, so "a title is present" would pass on the broken build.
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
  // Driven through the Mode control: the claim is what App does. The trap is
  // writing `{[activeTab]: mode}` instead of spreading, resetting the others.
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

  // List is the fourth mode and the only one that adds a renderer, so drive it
  // through the control: the claim is that App selects the renderer, not that the
  // string validates. Scenes has already shown the other three.
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
  // A downgrade or corrupt read must not reach a page, where an unknown string
  // falls through to the grid with nothing selected. The validator is pure.
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
  // Three silent failures: an empty description draws an empty row, an unbounded
  // blurb moves the strip, full aliases push everything off screen. Fixture rows
  // 1–4 and 10 cover each populated/empty combination and the overlong clamp.
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

  /** The blurb's two-line budget, measured not read off source: a declared but
   *  unapplied clamp still computes to two lines, so `scrollHeight > clientHeight`
   *  is what proves the cut. */
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
  // a card that is not mounted yet silently leaves the hero where it was:
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

  // A strip that is never told the request ended keeps the target and
  // re-centres on it pages later. One user key ends it before the deadline.
  const heard = [];
  const off = onFocusRestoreRequest((fid) => heard.push(fid));
  focusByIdWhenReady('ghost-card');
  await sleep(60);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  const ended = await waitFor(() => heard.includes(null), 1500);
  off();
  check('V9 an abandoned restore tells listeners it is over', ended,
    `heard ${JSON.stringify(heard)}`);
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
